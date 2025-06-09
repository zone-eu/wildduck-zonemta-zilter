'use strict';

const { request, RetryAgent, Agent, getGlobalDispatcher } = require('undici');
const { decodeWords } = require('libmime');
const { toUnicode } = require('punycode');
const { randomBytes } = require('node:crypto');

function decodeHeaderLineIntoKeyValuePair(headerLine) {
    let decodedHeaderStr;
    let headerSeparatorPos = headerLine.indexOf(':');
    if (headerSeparatorPos < 0) {
        return headerLine;
    }

    let headerKey = headerLine.substring(0, headerSeparatorPos);
    let headerValue = headerLine.substring(headerSeparatorPos + 1);

    try {
        decodedHeaderStr = decodeWords(headerValue);
    } catch (err) {
        // keep the value as is
        decodedHeaderStr = headerValue;
    }

    return [headerKey.trim(), decodedHeaderStr.trim()];
}

const loggelfForEveryUser = (app, short_message, data) => {
    if (data._rcpt.length > 1) {
        // send for every recipient

        for (const rcpt of data._rcpt) {
            app.loggelf({
                short_message,
                ...data,
                _rcpt: rcpt
            });
        }
    } else {
        if (!data.hasOwnProperty('_rcpt')) {
            data._rcpt = [];
        }

        app.loggelf({
            short_message,
            ...data,
            _rcpt: data._rcpt[0] || '' // single recipient
        });
    }
};

const normalizeDomain = domain => {
    domain = (domain || '').toLowerCase().trim();
    try {
        if (/^xn--/.test(domain)) {
            domain = toUnicode(domain).normalize('NFC').toLowerCase().trim();
        }
    } catch (E) {
        // ignore
    }

    return domain;
};

const normalizeAddress = (address, asObject) => {
    if (!address) {
        return address || '';
    }

    const user = address
        .substr(0, address.lastIndexOf('@'))
        .normalize('NFC')
        .toLowerCase()
        .replace(/\+[^@]*$/, '')
        .trim(); // get username from email, normalize it to NFC UTF-8, remove everything after plus sign, trim spaces
    const domain = normalizeDomain(address.substr(address.lastIndexOf('@') + 1)); // normalize domain
    const addr = user + '@' + domain; // actual user address
    const unameview = user.replace(/\./g, ''); // remove dots
    const addrview = unameview + '@' + domain; // address view

    if (asObject) {
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

// Global agent - connection pool
let agent;
const retryStatusCodes = [500, 502, 503, 504];
const errorCodes = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'UND_ERR_SOCKET']; // Default undici

module.exports.title = 'zilter';
module.exports.init = async app => {
    app.addHook('message:queue', async (envelope, messageInfo) => {
        // check with zilter
        // if incorrect do app.reject()

        const SUBJECT_MAX_ALLOWED_LENGTH = 16000;
        const { userName, apiKey, serverHost, zilterUrl, logIncomingData } = app.config;
        let { zilterFallbackUrl } = app.config;

        let subjectMaxLength = app.config.subjectMaxLength;

        if (!subjectMaxLength || subjectMaxLength > SUBJECT_MAX_ALLOWED_LENGTH) {
            subjectMaxLength = SUBJECT_MAX_ALLOWED_LENGTH;
        }

        if (logIncomingData) {
            // log available data
            app.logger.info('Incoming data: ', envelope, messageInfo, envelope.headers.getList());
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

        if (!zilterFallbackUrl) {
            // If no separate fallback given then default to original host
            zilterFallbackUrl = zilterUrl;
        }

        if (!agent) {
            // if agent has not yet been initialize then create one
            const { keepAliveTimeout, keepAliveMaxTimeout, maxRetries, minRetryTimeout, maxRetryTimeout, timeoutFactor } = app.config;
            agent = new RetryAgent(
                new Agent({
                    keepAliveTimeout: keepAliveTimeout || 5000,
                    keepAliveMaxTimeout: keepAliveMaxTimeout || 600e3,
                    connections: 50, // allow 50 concurrent sockets, client objects
                    pipelining: 1 // enable keep-alive, but do not pipeline
                }),
                {
                    maxRetries: maxRetries || 3,
                    minTimeout: minRetryTimeout || 100,
                    maxTimeout: maxRetryTimeout || 300,
                    timeoutFactor: timeoutFactor || 1.5,
                    statusCodes: retryStatusCodes,
                    errorCodes,
                    methods: ['POST', 'HEAD', 'OPTIONS', 'CONNECT']
                }
            );
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
                authenticatedUser = authenticatedUser.replace(/\./g, '').normalize('NFC').toLowerCase().trim(); // Normalize username to unameview
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
                _err_json: err.toString()
            });
            return;
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

        let subject = messageInfo.subject || allHeadersParsed.Subject || 'no subject';
        subject = subject.substring(0, subjectMaxLength);
        const messageIdHeaderVal = allHeadersParsed['Message-ID']?.replace('<', '').replace('>', '');

        let zilterResponse;

        const zilterRequestDataObj = {
            host: originhost, // Originhost is a string that includes [] (array as a string literal)
            'zilter-id': zilterId, // Random ID
            sender, // Sender User ID (uid) in the system
            helo: transhost, // Transhost is a string that includes [] (array as a string literal)
            'authenticated-sender': authenticatedUserAddress || authenticatedUser, // Sender user email
            'queue-id': envelope.id, // Queue ID of the envelope of the message
            'rfc822-size': messageSize, // Size of the raw RFC822-compatible e-mail
            from: envelope.from,
            rcpt: envelope.to,
            headers: messageHeadersList
        };

        // Call Zilter with required params
        try {
            let res;
            let hasRetriedAlready;
            try {
                res = await request(zilterUrl, {
                    dispatcher: getGlobalDispatcher(),
                    method: 'POST',
                    body: JSON.stringify(zilterRequestDataObj),
                    headers: { Authorization: `Basic ${userBase64}`, 'Content-Type': 'application/json' }
                });

                if (retryStatusCodes.includes(res.statusCode)) {
                    // Retry with fallback url
                    hasRetriedAlready = true;
                    res = await request(zilterFallbackUrl, {
                        dispatcher: agent, // use RetryAgent so in case of request fail - retry
                        method: 'POST',
                        body: JSON.stringify(zilterRequestDataObj),
                        headers: { Authorization: `Basic ${userBase64}`, 'Content-Type': 'application/json' }
                    });
                }
            } catch (error) {
                // Can be an error with an error code (ECONNRESET etc.)
                // Retry with fallback url if not retried before
                if (!hasRetriedAlready && (errorCodes.includes(error.code) || retryStatusCodes.includes(error.statusCode))) {
                    res = await request(zilterFallbackUrl, {
                        dispatcher: agent, // use RetryAgent so in case of request fail - retry
                        method: 'POST',
                        body: JSON.stringify(zilterRequestDataObj),
                        headers: { Authorization: `Basic ${userBase64}`, 'Content-Type': 'application/json' }
                    }); // If throws will be handled by outer catch block
                }
                throw error; // Throw original error to outer catch block
            }

            const resBodyJson = await res.body.json();

            const debugJson = { ...resBodyJson };

            zilterResponse = resBodyJson;

            if (debugJson.symbols) {
                ['SENDER', 'SENDER_GROUP', 'WEBHOOK'].forEach(sym => delete debugJson.symbols[sym]);
            }

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

                // Log zilter unauthorized to console
                const id = typeof envelope === 'object' ? envelope.id : envelope;

                let messageInfoStr = messageInfo;
                if (messageInfo && typeof messageInfo.format === 'function') {
                    messageInfoStr = messageInfo.format();
                }
                messageInfoStr = (messageInfoStr || '').toString().trim();

                const msg = '%s NOQUEUE [unauthorized]' + (messageInfoStr ? ' (' + messageInfoStr + ')' : '');
                app.logger.info(app.options.title, msg, id);
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

                // Log zilter banned to console
                const id = typeof envelope === 'object' ? envelope.id : envelope;

                let messageInfoStr = messageInfo;
                if (messageInfo && typeof messageInfo.format === 'function') {
                    messageInfoStr = messageInfo.format();
                }
                messageInfoStr = (messageInfoStr || '').toString().trim();

                const msg =
                    '%s NOQUEUE [banned]' +
                    (messageInfoStr ? ' (' + messageInfoStr + ')' : '') +
                    (resBodyJson.action ? ` (passed=N action=${resBodyJson.action})` : ` (passed=N)`);
                app.logger.info(app.options.title, msg, id);
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

                // Log Zilter pass check to console
                const id = typeof envelope === 'object' ? envelope.id : envelope;

                let messageInfoStr = messageInfo;
                if (messageInfo && typeof messageInfo.format === 'function') {
                    messageInfoStr = messageInfo.format();
                }
                messageInfoStr = (messageInfoStr || '').toString().trim();

                const msg =
                    '%s QUEUE [passed]' +
                    (messageInfoStr ? ' (' + messageInfoStr + ')' : '') +
                    (resBodyJson.action ? ` (passed=Y action=${resBodyJson.action})` : ` (passed=Y)`);
                app.logger.info(app.options.title, msg, id);
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
                messageInfo,
                `550 ${zilterResponse && zilterResponse.symbols ? `SENDING BLOCKED, REASON: ${zilterResponse.symbols.REJECT_REASON}` : 'SENDING BLOCKED'}`
            );
        }

        if (isTempFail) {
            throw app.reject(envelope, 'tempfail', messageInfo, 'Temporary error, please try again later.');
        }

        return;
    });
};
