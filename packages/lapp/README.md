# @openlapp/lapp

TypeScript SDK for [LAPP](https://github.com/openlapp/lapp) (Local AI Provider Profiles).

Read, validate, write, manage `.lapp` profiles and call providers directly — no gateway, no persistent server.

## Install

```bash
npm install @openlapp/lapp
```

## Quick start

```ts
import { loadProfile, createLappClient } from "@openlapp/lapp";

const profile = loadProfile();                  // resolves ~/.lapp
const client = createLappClient({
  profile,
  provider: "openai",
  model: "gpt-4o",
  resolveSecrets: true,
});

const resp = await client.chat({
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.text);
```

## API

See the [main repo](https://github.com/openlapp/lapp-js) for full documentation.

## License

MIT
