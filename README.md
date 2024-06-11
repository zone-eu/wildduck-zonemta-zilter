# Zilter plugin for Zone-MTA
> zonemta-plugin-zilter
> npm: wildduck-zonemta-zilter

The main plugin code is in the `index.js` file.

Example config is stored in the `zilter.toml` file.
The only fields that need configurating are:
- `userName` - Zilter auth username
- `apiKey` - Zilter auth apikey or password
- `serverHost` - Domain/hostname of the current server/VPS etc.

Logging is done via Gelf.
Configure gelf in the main zone-mta installation. Not here.

To add the plugin to your ZoneMTA/Wildduck installation.
Add the given `zilter.toml` to the `config` folder of the installation OR  
Add the following to your 'plugins' section of ZoneMTA/Wildduck:
```json
...
  "plugins": {
    "modules/wildduck-zonemta-zilter": {
        "enabled": "receiver",
        "userName": "valid zilter username",
        "apiKey": "valid zilter apikey",
        "serverHost": "your server/vps/machine hostname with http/https"
    }
  }
...
```
