'use strict';

const undici = require('undici');
const addressTools = require('zone-mta/lib/address-tools');
const { randomBytes } = require('node:crypto');

module.exports.title = 'Zilter';
module.exports.init = async app => {
    app.addHook('message:queue', async (envelope, messageinfo) => {
        // check with zilter
        // if incorrect do app.reject()

        const { userName, apiKey, serverHost, zilterUrl } = app.config;

        if (!userName || !apiKey) {
            // if either username or apikey missing skip check
            app.loggelf({
                short_message: '[ZONE-MTA-ZILTER] auth missing',
                _plugin_status: 'error',
                _error: 'Username and/or API key missing from config in order to auth to Zilter.'
            });
            return;
        }

        if (!serverHost) {
            // log that we are missing serverhost and we're using the originhost instead
            app.loggelf({
                short_message: '[ZONE-MTA-ZILTER] serverhost missing',
                _plugin_status: 'warning',
                _error: 'Serverhost config missing, using envelope originhost instead. Check config.'
            });
        }

        if (!zilterUrl) {
            app.loggelf({
                short_message: '[ZONE-MTA-ZILTER] zilter url missing',
                _plugin_status: 'error',
                _error: 'Zilter URL is missing, add it. Aborting check'
            });
            return;
        }

        // check whether we need to resolve for email
        let authenticatedUser = envelope.user || '';
        let authenticatedUserAddress;

        let sender;

        try {
            if (authenticatedUser.includes('@')) {
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
                short_message: '[ZONE-MTA-ZILTER] DB error',
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

        // Change headers to the format that Zilter will accept
        for (const headerObj of envelope.headers.getList()) {
            messageHeadersList.push({
                name: headerObj.key,
                value: headerObj.line
            });
        }

        const zilterId = randomBytes(8).toString('hex');

        // Call Zilter with required params
        try {
            const res = await undici.request(zilterUrl, {
                dispatcher: undici.getGlobalDispatcher(),
                method: 'POST',
                body: JSON.stringify({
                    host: serverHost || (envelope.originhost || '').replace('[', '').replace(']', ''), // Originhost is a string that includes [] (array as a string literal)
                    'zilter-id': zilterId, // Random ID
                    sender, // Sender User ID (uid) in the system
                    helo: (envelope.transhost || '').replace('[', '').replace(']', ''), // Transhost is a string that includes [] (array as a string literal)
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
                app.loggelf({
                    short_message: '[ZONE-MTA-ZILTER] Zilter request unauthorized',
                    _plugin_status: 'error',
                    _status_code: res.statusCode,
                    _host: serverHost || (envelope.originhost || '').replace('[', '').replace(']', ''),
                    _zilter_id: zilterId,
                    _sender: sender,
                    _helo: (envelope.transhost || '').replace('[', '').replace(']', ''),
                    _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                    _queue_id: envelope.id,
                    _rfc822_size: messageSize,
                    _from: envelope.from,
                    _rcpt: envelope.to,
                    _headers: messageHeadersList
                });
            }

            if (resBodyJson.action && resBodyJson.action !== 'accept') {
                // not accepted
                passEmail = false;
                app.loggelf({
                    short_message: '[ZONE-MTA-ZILTER] Email did not pass check',
                    _plugin_status: 'info',
                    _host: serverHost || (envelope.originhost || '').replace('[', '').replace(']', ''),
                    _zilter_id: zilterId,
                    _sender: sender,
                    _helo: (envelope.transhost || '').replace('[', '').replace(']', ''),
                    _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                    _queue_id: envelope.id,
                    _rfc822_size: messageSize,
                    _from: envelope.from,
                    _rcpt: envelope.to,
                    _headers: messageHeadersList,
                    _zilter_action: resBodyJson.action,
                    _status_code: res.statusCode
                });
            } else if (resBodyJson.action && resBodyJson.action === 'accept') {
                app.loggelf({
                    short_message: '[ZONE-MTA-ZILTER] Email passed check',
                    _plugin_status: 'info',
                    _host: serverHost || (envelope.originhost || '').replace('[', '').replace(']', ''),
                    _zilter_id: zilterId,
                    _sender: sender,
                    _helo: (envelope.transhost || '').replace('[', '').replace(']', ''),
                    _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                    _queue_id: envelope.id,
                    _rfc822_size: messageSize,
                    _from: envelope.from,
                    _rcpt: envelope.to,
                    _headers: messageHeadersList,
                    _zilter_action: resBodyJson.action,
                    _status_code: res.statusCode
                });
            }
        } catch (err) {
            app.loggelf({
                short_message: '[ZONE-MTA-ZILTER] Zilter request error',
                _plugin_status: 'error',
                _error: err.message,
                _host: serverHost || (envelope.originhost || '').replace('[', '').replace(']', ''),
                _zilter_id: zilterId,
                _sender: sender,
                _helo: (envelope.transhost || '').replace('[', '').replace(']', ''),
                _authenticated_sender: authenticatedUserAddress || authenticatedUser,
                _queue_id: envelope.id,
                _rfc822_size: messageSize,
                _from: envelope.from,
                _rcpt: envelope.to,
                _headers: messageHeadersList
            });
        }

        if (!passEmail) {
            // rejected
            throw app.reject(envelope, 'banned', messageinfo, '550 SMTP ACCESS DENIED - ABUSE PREVENTION HAS TRIGGERED A BAN DUE TO REACHED RATE LIMITS.');
        }

        return;
    });
};
