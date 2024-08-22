'use strict';

const undici = require('undici');
const addressTools = require('zone-mta/lib/address-tools');
const { randomBytes } = require('node:crypto');
const os = require('os');

const loggelfForEveryUser = (app, short_message, data) => {
    const timestamp = Date.now() / 1000;
    const hostname = os.hostname();

    if (data._rcpt.length > 1) {
        // send for every recipient

        for (const rcpt of data._rcpt) {
            app.gelf.emit('gelf.log', {
                short_message,
                ...data,
                _rcpt: rcpt,
                timestamp,
                host: hostname
            });
        }
    } else {
        if (!data.hasOwnProperty('_rcpt')) {
            data._rcpt = [];
        }

        app.gelf.emit('gelf.log', {
            short_message,
            ...data,
            _rcpt: data._rcpt[0] || '', // single recipient
            timestamp,
            host: hostname
        });
    }
};

module.exports.title = 'Zilter';
module.exports.init = async app => {
    app.addHook('message:queue', async (envelope, messageinfo) => {
        // check with zilter
        // if incorrect do app.reject()

        const { userName, apiKey, serverHost, zilterUrl, logIncomingData } = app.config;

        if (logIncomingData) {
            // log available data
            app.logger.info('Incoming data: ', envelope, messageinfo, envelope.headers.getList());
        }

        if (!userName || !apiKey) {
            // if either username or apikey missing skip check
            app.loggelf({
                short_message: '[WILDDUCK-ZONEMTA-ZILTER] auth missing',
                _plugin_status: 'error',
                _error: 'Username and/or API key missing from config in order to auth to Zilter.'
            });
            return;
        }

        if (!serverHost) {
            // log that we are missing serverhost and we're using the originhost instead
            app.loggelf({
                short_message: '[WILDDUCK-ZONEMTA-ZILTER] serverhost missing',
                _plugin_status: 'warning',
                _error: 'Serverhost config missing, using envelope originhost instead. Check config.'
            });
        }

        if (!zilterUrl) {
            app.loggelf({
                short_message: '[WILDDUCK-ZONEMTA-ZILTER] zilter url missing',
                _plugin_status: 'error',
                _error: 'Zilter URL is missing, add it. Aborting check'
            });
            return;
        }

        // check whether we need to resolve for email
        let authenticatedUser = envelope.user || '';
        let authenticatedUserAddress;

        let sender;

        const smtpUsernamePatternRegex = /\[([^\]]+)]/;

        try {
            if (envelope.userId && authenticatedUser) {
                // have both userId and user. Probably webmail. Set sender to the userId straight away
                // first check though that the userId is a 24 length hex

                if (envelope.userId.length === 24) {
                    sender = envelope.userId.toString();
                }
            } else if (authenticatedUser.includes('@')) {
                if (smtpUsernamePatternRegex.test(authenticatedUser)) {
                    // SMTP username[email]

                    let match = authenticatedUser.match(smtpUsernamePatternRegex);
                    if (match && match[1]) {
                        authenticatedUser = match[1]; // is email address
                    }
                }

                // SMTP email aadress login
                // seems to be an email, no need to resolve, straight acquire the user id from addresses
                const addressData = await app.db.users.collection('addresses').findOne({ addrview: addressTools.normalizeAddress(authenticatedUser) });
                sender = addressData.user.toString();
            } else {
                // current user authenticated via the username, resolve to email
                authenticatedUser = authenticatedUser.replace(/\./g, '').toLowerCase(); // Normalize username to unameview
                const userData = await app.db.users.collection('users').findOne({ unameview: authenticatedUser });
                authenticatedUserAddress = userData.address; // main address of the user
                sender = userData._id.toString(); // ID of the user
            }
        } catch (err) {
            app.loggelf({
                short_message: '[WILDDUCK-ZONEMTA-ZILTER] DB error',
                _plugin_status: 'error',
                _error: 'DB error. Check DB connection, or collection names, or filter params.',
                _authenticated_user: authenticatedUser
            });
            return;
        }

        // construct Authorization header
        const userBase64 = Buffer.from(`${userName}:${apiKey}`).toString('base64'); // authorization header

        const messageSize = envelope.headers.build().length + envelope.bodySize; // RFC822 size (size of Headers + Body)

        let passEmail = true;

        const messageHeadersList = [];

        const allHeadersParsed = {};

        // Change headers to the format that Zilter will accept
        for (const headerObj of envelope.headers.getList()) {
            // Get header Key and Value from line
            const splittedByFirstColumn = headerObj.line.split(/:(.*)/s);

            const headerKey = splittedByFirstColumn[0].trim();
            const headerValue = splittedByFirstColumn[1].trim();

            allHeadersParsed[headerKey] = headerValue;

            messageHeadersList.push({
                name: headerKey,
                value: headerValue
            });
        }

        const zilterId = randomBytes(8).toString('hex');

        const originhost = serverHost || (envelope.originhost || '').replace('[', '').replace(']', '');
        const transhost = (envelope.transhost || '').replace('[', '').replace(']', '') || originhost;

        const subject = messageinfo.subject || 'no subject';
        const messageIdHeaderVal = allHeadersParsed['Message-ID']?.replace('<', '').replace('>', '');

        // Call Zilter with required params
        try {
            const res = await undici.request(zilterUrl, {
                dispatcher: undici.getGlobalDispatcher(),
                method: 'POST',
                body: JSON.stringify({
                    host: originhost, // Originhost is a string that includes [] (array as a string literal)
                    'zilter-id': zilterId, // Random ID
                    sender, // Sender User ID (uid) in the system
                    helo: transhost, // Transhost is a string that includes [] (array as a string literal)
                    'authenticated-sender': authenticatedUserAddress || authenticatedUser, // Sender user email
                    'queue-id': envelope.id,
                    'rfc822-size': messageSize,
                    from: envelope.from,
                    rcpt: envelope.to,
                    headers: messageHeadersList
                }),
                headers: { Authorization: `Basic ${userBase64}`, 'Content-Type': 'application/json' }
            });
            const resBodyJson = await res.body.json();

            if (res.statusCode === 401) {
                // unauthorized Zilter
                loggelfForEveryUser(app, subject, {
                    _sender: sender,
                    _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                    _rfc822_size: messageSize,
                    _app: 'zilter',
                    _rcpt: envelope.to,
                    _from: envelope.from,
                    _header_from: allHeadersParsed.From,
                    _header_to: allHeadersParsed.To,
                    _message_id: messageIdHeaderVal,
                    _subject: subject,
                    level: 5,
                    _zilter_error: 'Unauthorized error 401',
                    _ip: envelope.origin
                });
            }

            if (resBodyJson.action && resBodyJson.action !== 'accept') {
                // not accepted
                passEmail = false;
                loggelfForEveryUser(app, subject, {
                    _sender: sender,
                    _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                    _rfc822_size: messageSize,
                    _app: 'zilter',
                    _rcpt: envelope.to,
                    _from: envelope.from,
                    _header_from: allHeadersParsed.From,
                    _header_to: allHeadersParsed.To,
                    _message_id: messageIdHeaderVal,
                    _subject: subject,
                    level: 5,
                    _passed: 'N',
                    _action: resBodyJson.action,
                    _ip: envelope.origin
                });
            } else if (resBodyJson.action && resBodyJson.action === 'accept') {
                loggelfForEveryUser(app, subject, {
                    _sender: sender,
                    _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                    _rfc822_size: messageSize,
                    _app: 'zilter',
                    _rcpt: envelope.to,
                    _from: envelope.from,
                    _header_from: allHeadersParsed.From,
                    _header_to: allHeadersParsed.To,
                    _message_id: messageIdHeaderVal,
                    _subject: subject,
                    level: 5,
                    _passed: 'Y',
                    _ip: envelope.origin
                });
            }
        } catch (err) {
            loggelfForEveryUser(app, subject, {
                _sender: sender,
                _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                _rfc822_size: messageSize,
                _app: 'zilter',
                _rcpt: envelope.to,
                _from: envelope.from,
                _header_from: allHeadersParsed.From,
                _header_to: allHeadersParsed.To,
                _message_id: messageIdHeaderVal,
                _subject: subject,
                level: 5,
                _zilter_error: err.message,
                _ip: envelope.origin
            });
        }

        if (!passEmail) {
            // rejected
            throw app.reject(envelope, 'banned', messageinfo, '550 SMTP ACCESS DENIED - ABUSE PREVENTION HAS TRIGGERED A BAN DUE TO REACHED RATE LIMITS.');
        }

        return;
    });
};
