'use strict';

const undici = require('undici');
const addressTools = require('zone-mta/lib/address-tools');
const libmime = require('libmime');
const { randomBytes } = require('node:crypto');
const os = require('os');

function decodeHeaderLineIntoKeyValuePair(headerLine) {
    let decodedHeaderStr;
    let headerSeparatorPos = headerLine.indexOf(':');
    if (headerSeparatorPos < 0) {
        return headerLine;
    }

    let headerKey = headerLine.substring(0, headerSeparatorPos);
    let headerValue = headerLine.substring(headerSeparatorPos + 1);

    try {
        decodedHeaderStr = libmime.decodeWords(headerValue);
    } catch (err) {
        // keep the value as is
        decodedHeaderStr = headerValue;
    }

    return [headerKey.trim(), decodedHeaderStr.trim()];
}

const loggelf = (app, message) => {
    Object.keys(message).forEach(key => {
        if (!message[key]) {
            // remove falsy keys (undefined, null, false, "", 0)
            delete message[key];
        }
    });

    app.gelf.emit('gelf.log', message);
};

const loggelfForEveryUser = (app, short_message, data) => {
    const timestamp = Date.now() / 1000;
    const hostname = os.hostname();

    if (data._rcpt.length > 1) {
        // send for every recipient

        for (const rcpt of data._rcpt) {
            loggelf(app, {
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

        loggelf(app, {
            short_message,
            ...data,
            _rcpt: data._rcpt[0] || '', // single recipient
            timestamp,
            host: hostname
        });
    }
};

const normalizeAddress = (authenticatedUser, returnAsObject) => {
    const user = authenticatedUser.substr(0, authenticatedUser.lastIndexOf('@')).normalize('NFC').toLowerCase().trim();
    const domain = authenticatedUser.substr(authenticatedUser.lastIndexOf('@') + 1);
    const addr = user.trim() + '@' + addressTools.normalizeDomain(domain);
    const unameview = user.trim().replace(/\./g, '');
    const addrview = unameview + '@' + domain;

    if (returnAsObject) {
        return {
            user,
            unameview,
            addrview,
            domain,
            addr
        };
    }
    return addr;
};

module.exports.title = 'Zilter';
module.exports.init = async app => {
    app.addHook('message:queue', async (envelope, messageinfo) => {
        // check with zilter
        // if incorrect do app.reject()

        const SUBJECT_MAX_ALLOWED_LENGTH = 16000;
        const { userName, apiKey, serverHost, zilterUrl, logIncomingData } = app.config;

        let subjectMaxLength = app.config.subjectMaxLength;

        if (!subjectMaxLength || subjectMaxLength > SUBJECT_MAX_ALLOWED_LENGTH) {
            subjectMaxLength = SUBJECT_MAX_ALLOWED_LENGTH;
        }

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

        let passEmail = true; // by default pass email
        let isTempFail = true; // by default tempfail

        try {
            if (authenticatedUser.includes('@')) {
                if (smtpUsernamePatternRegex.test(authenticatedUser)) {
                    // SMTP username[email]

                    let match = authenticatedUser.match(smtpUsernamePatternRegex);
                    if (match && match[1]) {
                        authenticatedUser = match[1]; // is email address
                    }
                }

                // SMTP email aadress login
                // seems to be an email, no need to resolve, straight acquire the user id from addresses
                // normalize address
                let addrObj = normalizeAddress(authenticatedUser, true);
                authenticatedUser = addrObj.addr;

                // check for alias
                let aliasData = await app.db.users.collection('domainaliases').findOne({ alias: addrObj.domain });

                let addrview = addrObj.addrview; // default to addrview query as-is without alias

                if (aliasData) {
                    // got alias data
                    const aliasDomain = aliasData.domain;
                    addrview = addrObj.unameview + '@' + aliasDomain; // set new query addrview
                }

                const addressData = await app.db.users.collection('addresses').findOne({ addrview });
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
                _authenticated_user: authenticatedUser,
                _err_json: JSON.stringify(err)
            });
            throw app.reject(envelope, 'tempfail', messageinfo, 'Temporary error, please try again later.');
        }

        // construct Authorization header
        const userBase64 = Buffer.from(`${userName}:${apiKey}`).toString('base64'); // authorization header

        const messageSize = envelope.headers.build().length + envelope.bodySize; // RFC822 size (size of Headers + Body)

        const messageHeadersList = [];

        const allHeadersParsed = {};

        // Change headers to the format that Zilter will accept
        for (const headerObj of envelope.headers.getList()) {
            // Get header Key and Value from line
            const [headerKey, headerValue] = decodeHeaderLineIntoKeyValuePair(headerObj.line);

            allHeadersParsed[headerKey] = headerValue;

            messageHeadersList.push({
                name: headerKey,
                value: headerValue
            });
        }

        const zilterId = randomBytes(8).toString('hex');

        const originhost = serverHost || (envelope.originhost || '').replace('[', '').replace(']', '');
        const transhost = (envelope.transhost || '').replace('[', '').replace(']', '') || originhost;

        let subject = messageinfo.subject || allHeadersParsed.Subject || 'no subject';
        subject = subject.substring(0, subjectMaxLength);
        const messageIdHeaderVal = allHeadersParsed['Message-ID']?.replace('<', '').replace('>', '');

        let zilterResponse;

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

            const debugJson = { ...resBodyJson };

            zilterResponse = resBodyJson;

            ['SENDER', 'SENDER_GROUP', 'WEBHOOK'].forEach(sym => {
                if (debugJson.symbols) {
                    delete debugJson.symbols[sym];
                }
            });
            ['sender', 'action', 'zilter-id', 'client'].forEach(el => delete debugJson[el]);

            if (res.statusCode === 401) {
                // unauthorized Zilter, default to tempfail error return
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
                    _ip: envelope.origin,
                    _debug_json: debugJson
                });
            }

            if (resBodyJson.action && resBodyJson.action !== 'accept') {
                if (resBodyJson.action !== 'tempfail') {
                    isTempFail = false; // not a tempfail error
                }

                // not accepted, email did not pass checks
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
                    _ip: envelope.origin,
                    _debug_json: debugJson
                });
            } else if (resBodyJson.action && resBodyJson.action === 'accept') {
                // accepted, so not a tempfail
                isTempFail = false;
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
                    _ip: envelope.origin,
                    _debug_json: debugJson
                });
            }
        } catch (err) {
            // error, default to tempfail
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
            // sending e-mail rejected
            throw app.reject(
                envelope,
                'banned',
                messageinfo,
                `550 ${zilterResponse && zilterResponse.symbols ? `SENDING BLOCKED, REASON: ${zilterResponse.symbols.REJECT_REASON}` : 'SENDING BLOCKED'}`
            );
        }

        if (isTempFail) {
            throw app.reject(envelope, 'tempfail', messageinfo, 'Temporary error, please try again later.');
        }

        return;
    });
};
