# CRC Replenisher

>> ⚠️ Warning: 
>> **This tool requires your private key, so don't use it!**

Improper handling of your private key can result in complete loss of access to your CRC account and all associated funds. Only use this tool if you fully understand what you're doing and the security implications of exposing your private key to a random script found online.

Now, if you really did your homework and looked through the code and dependencies, then read on.

---

This is a TypeScript utility that automatically replenishes and wraps your personal Circles (CRC) tokens.

Trusting people in the CRC ecosystem means accepting their CRC, but their CRC is not always tradeable.
When your personal CRC is more valuable, and you want to replenish it automatically, run this script.

This script is entirely based on the [CRC replenisher tool](https://koeppelmann.github.io/CirclesTools/replenishMyCRC.html) by [@koeppelmann](https://github.com/koeppelmann/CirclesTools/blob/main/replenishMyCRC.html)

The tool uses the Circles SDK and Safe SDK to interact with the Circles ecosystem on Gnosis Chain.

## What it does

This tool runs in a loop with configurable thresholds and timing and:
- Finds paths to transfer available CRC tokens to yourself, if any.
- Wraps any resulting personal tokens into static CRC tokens

## Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Set environment variables:
   ```bash
   export CRC_SAFE_KEY="your_private_key" // you can find this using devtools on app.aboutcircles.com, in localstorage
   export CRC_PROFILE="0x_your_circles_profile_address"
   export MAX_RUN_MS="300000"  # Optional: max runtime in ms (0 = infinite)
   export MAX_FLOW_THRESHOLD="1.0"  # Optional: minimum CRC threshold
   export RPC_URL="https://rpc.gnosischain.com/"  # Optional: custom RPC
   ```

## Usage

### Local Development

```bash
pnpm start
```

### GitHub Actions (Automated)

The repository includes a GitHub Actions workflow that runs the replenisher every 5 minutes automatically.

To set it up:

1. Fork this repository
2. Go to Settings → Secrets and variables → Actions
3. In the "Variables" tab, add:
   - `JOB_ENABLED` (required): Set to `true` to enable the workflow
4. In the "Secrets" tab, add:
   - `CRC_SAFE_KEY` (required): Your private key
   - `CRC_PROFILE` (required): Your Circles profile address (0x...)
   - `MAX_FLOW_THRESHOLD` (optional): Minimum CRC threshold (default: 1.0)
   - `RPC_URL` (optional): Custom RPC endpoint (default: https://rpc.gnosischain.com/)

The workflow will run automatically every 5 minutes once enabled, or you can trigger it manually from the Actions tab. To disable, set `JOB_ENABLED` to anything other than `true`.

## Requirements

- Node.js ≥20.0.0
- A Circles profile on Gnosis Chain
- Private key for your CRC Safe wallet
