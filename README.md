# Zilter plugin for Zone-MTA
> zonemta-plugin-zilter

The main plugin code is in the `index.js` file.

Example config is stored in the `zilter.toml` file.
The only fields that need configurating are:
- `userName` - Zilter auth username
- `apiKey` - Zilter auth apikey or password
- `serverHost` - Domain/hostname of the current server/VPS etc.

Logging is done via Gelf.
Configure gelf in the main zone-mta installation. Not here.
