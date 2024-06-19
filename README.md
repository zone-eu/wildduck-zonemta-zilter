# Zilter plugin for Zone-MTA and Wildduck
> wildduck-zonemta-zilter

The main plugin code is in the `index.js` file.

Example config is stored in the `wildduck-zonemta-zilter.toml` file.
The only fields that need configurating are:
- `userName` - Zilter auth username
- `apiKey` - Zilter auth apikey or password
- `serverHost` - Domain/hostname of the current server/VPS etc.
- `logIncomingData` - Log the callback parameters. Useful for debugging.

Logging is done via `Gelf`.
Configure gelf in the main Zone-MTA/Wildduck installation. Not here.

To add the plugin to your ZoneMTA/Wildduck installation.
Add the given `wildduck-zonemta-zilter.toml` to the `config` folder of the installation OR  
Add the following to your `'plugins'` section of ZoneMTA/Wildduck:
```json
...
  "plugins": {
    "modules/wildduck-zonemta-zilter": {
        "enabled": "receiver",
        "userName": "valid zilter username",
        "apiKey": "valid zilter apikey",
        "serverHost": "your server/vps/machine hostname, withou http/https",
        "logIncomingData": false
    }
  }
...
```

> NOTE! Currently (June 2024) it seems that, If your email domain is same as the VPS/Server domain then Zilter  
> will reject intra-domain emails (emails between users of the same domain)  
> To send messages between users of the same domain or to yourself  
> you either have to have a different domain name for the VPS and the emails  
> OR configure serverHost as the **IP** of the VPS/Server, not the actual hostname/domain name.  
> For example: `189.250.21.190` instead of `my.domain.com`