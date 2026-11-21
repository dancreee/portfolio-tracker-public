# Portfolio tracker

A local, read-only portfolio tracker: live balances and prices across EVM chains, Hyperliquid,
Solana, Pearl and centralised exchanges, with cost basis and full buy/sell history.

![Overview page with demo data](docs/overview.png)

*Screenshot uses made-up demo data.*

- **Private by design.** One Node process and one SQLite file on your machine. No hosted backend,
  no telemetry, no external scripts or fonts. The server listens on `127.0.0.1` only.
- **Read-only.** It only ever needs public wallet addresses and read-only exchange keys. It cannot
  move funds and never asks for a private key or seed phrase.
- **Zero dependencies.** Needs Node 22.13 or newer and nothing else (`node:sqlite`, built-in `fetch`).
- **No manual token lists.** Tokens are discovered from what your wallets hold and priced by
  contract address. Spam airdrops are kept out of totals.

## Quick start

1. Install [Node.js](https://nodejs.org) 22.13 or newer (`node -v` to check).
2. Get the code and start it. There is nothing to `npm install`.

   ```sh
   git clone https://github.com/dancreee/portfolio-tracker-public.git portfolio-tracker
   cd portfolio-tracker
   npm start
   ```

3. Open <http://localhost:4321>.
4. Go to **Accounts** and choose **Add account**:
   - **EVM wallet**: paste a `0x…` address. The main chains are scanned automatically and the same
     address is checked on Hyperliquid (spot, staking, perps).
   - **Solana** or **Pearl wallet**: paste the address.
   - **Exchange** (Kraken or Binance): paste a **read-only** API key and secret. Create a key with
     query/read permissions only, with trading and withdrawals switched off.
   - **Manual**: holdings you type in yourself, such as a brokerage account.
5. Optional but recommended, under **Settings**:
   - **Blockscout API key** (free, from [dev.blockscout.com](https://dev.blockscout.com)). Some
     chain explorers refuse requests without one.
   - **Alchemy API key**. Only used as a fallback where Blockscout's free plan has no coverage
     (Base, for example), and throttled to keep usage low.
   - **Public RPC endpoints**. Balances are read from free public RPCs first, three per chain by
     default. You can replace them per chain, for example with a private Solana endpoint, since
     the public Solana RPC is slow and rate-limited.

   Wallets you own but do not want tracked, such as old wallets, can be added as accounts and
   then disabled. Transfers to and from them are then treated as internal rather than as deposits
   and withdrawals.

Balances appear within a minute. Full history, and therefore cost basis, can take a few minutes on
the first run for wallets with many transactions.

`npm run dev` does the same as `npm start` but restarts when a source file changes.

## Where your data lives

Everything you enter, including exchange keys, is stored in `data/portfolio.db` next to the code and
nowhere else. `data/`, `.env` and `accounts.seed.json` are gitignored, so a fork or pull request
will not pick them up. Keys are stored unencrypted in that file, so protect it like any other
credential: use read-only keys, and do not sync the folder to a shared drive.

To start over, stop the app and delete the `data/` folder.

Your wallet addresses are sent to the services below in order to look up balances, the same as
opening a block explorer. Nothing else leaves your machine.

## What it reads

| Source | How | Key needed |
| --- | --- | --- |
| EVM wallets (Ethereum, Base, Arbitrum, Optimism, Robinhood Chain, Polygon, more) | Public RPCs for balances (free, editable in Settings), then Blockscout REST API for token discovery and history, then Alchemy as a last resort | free Blockscout key recommended |
| Hyperliquid (spot, staking, perps, fills) | Hyperliquid info API, checked for every EVM wallet | no |
| Solana wallets | Solana JSON-RPC | no |
| Pearl wallets | Pearl explorer | no |
| Kraken, Binance | Exchange REST API | read-only API key |
| Prices | DefiLlama (live and historical), GeckoTerminal for long-tail tokens, Hyperliquid and exchange tickers | no |

Ethereum, Base, Arbitrum, Optimism and Robinhood Chain are scanned for every EVM wallet. Polygon,
Unichain, Gnosis, Scroll and zkSync can be switched on per account. Chains are defined in
`src/chains.js`.

## Cost basis

History is rebuilt from every transfer, swap and fill, then run through average cost per asset:

- **Swaps and fills** are buys/sells at the price actually paid (stablecoin side or fill price).
- **Transfers between your own accounts** keep their basis. They are recognised by address, or by a
  matching amount leaving one account and arriving in another within three days (bridges, exchange
  withdrawals). List old wallets under Settings so basis follows funds through them.
- **Deposits from elsewhere** enter at the market price at that time.
- **Withdrawals** remove holdings at average cost; **fees** are realised losses.
- Any line can be reclassified or re-priced by hand from the asset's history.

Figures are estimates for your own tracking, not tax or financial advice.

## Trade plans (optional)

Switch on **Trade plans** in Settings to keep one plan per asset: thesis, what would prove it
wrong, entry, stop, target and optional bear / base / bull notes. The entry is filled in from your
average cost. Every save is kept as a version and the newest one is the plan.

- Assets without a plan get a small "no plan" badge. A buy or sell made after the plan was last
  updated asks you to review it.
- Once an asset is sold completely, the trade moves to the **Closed** tab on the Assets page with
  its dates, cost basis, proceeds, realised PnL, the plan as it stood and an exit note. Buying the
  asset back starts a new plan.
- Closed trades with a cost basis under $100 are left off the Closed tab; the amount is set in
  Settings. Only trades closed after you switched trade plans on ask for an exit note.

Stop and target are notes: nothing is traded or alerted. Switching the feature off hides it and
keeps everything you wrote.

## Importing history from another tracker

If you are moving from another portfolio tracker and can export its snapshots, import them so the
value chart does not start on the day you installed this one:

    node --experimental-sqlite scripts/import-history.js history.jsonl
    # optionally leave out a period the old tracker got wrong:
    #   --skip 2025-06-01T00:00Z,2025-06-08T00:00Z

The file has one JSON object per line: `{"t": time, "v": total USD, "p": [{"sy", "amt", "px", "usd", "cat", "ty"}]}`
(positions are optional; see `src/history-import.js`). The import:

- fills the value chart for the time before this tracker's own first snapshot;
- keeps the old tracker's daily prices as a last fallback for cost basis, used only where no market
  price history exists (shown as "imported history" on the asset's history);
- takes each asset's category for the Allocation panel's Categories view. Without an import,
  categories are Stablecoins, Stocks, BTC, ETH, SOL, HYPE and Other.

Running it again replaces the earlier import. Restart the tracker afterwards.

## Refresh rates

Prices every 15 s, Hyperliquid every 10 s, wallet balances every 60 s, history every 5 min.
Paid or rationed services are used sparingly: Blockscout and Alchemy are only asked after a public RPC
has seen a balance move (plus a slow safety check), a failed history read waits an hour before it is
tried again, and Hyperliquid requests share one budget well under its per-minute limit. Settings shows
how many requests went to each service today and yesterday.
A portfolio value snapshot is stored every 5 min for the chart.

## Configuration

All optional. Set these in the environment or in a `.env` file next to `package.json`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind to |
| `ALLOWED_HOSTS` | none | Extra hostnames the app may be browsed at, comma separated |
| `PORTFOLIO_DB` | `data/portfolio.db` | Path to the SQLite file |
| `BLOCKSCOUT_API_KEY`, `ALCHEMY_API_KEY` | none | Same as the keys in Settings, which take priority |

To pre-load accounts instead of typing them in, copy `accounts.seed.example.json` to
`accounts.seed.json` and edit it. It is imported once, on the first run with an empty database.

## Serving on a private network

Set `HOST` to the interface IP (for example your Tailscale IP) and `ALLOWED_HOSTS` to the hostnames
you browse to. **Do not expose the port to the public internet: there is no login.**

## Troubleshooting

- **`node:sqlite` errors or "bad option" on start**: Node is too old. Upgrade to 22.13 or newer.
- **A chain shows as failing**: add a Blockscout API key in Settings. The sidebar lists which
  sources are failing and why.
- **Cost basis shows as partly known**: history has not finished syncing, or funds came from a
  wallet the app does not know about. Add that wallet as an account (disable it if you do not want it tracked).
- **Exchange errors**: check the key is read-only and has permission to query balances, trades and
  ledger/deposit history.

## Tests

```sh
npm test
```

Tests run offline against fixtures. Any keys or addresses in `test/` are placeholders.

## Licence

MIT. See [LICENSE](LICENSE).
