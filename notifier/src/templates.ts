/**
 * Message templates: one pure function per event kind in events.ts, payload → message.
 *
 *   { title, body, url }   plain text only. Channels add their own framing (telegram.ts,
 *                          webpush.ts, email.ts): the title as a first line, a push title or a
 *                          subject; the url as a link; a settings footer.
 *
 * COPY RULES (plan README "Copy rules", scripts/copy-lint.mjs), pinned by templates.test.ts:
 *   - "Stock Tokens", never any other name for them.
 *   - Every message about a long position (a payoff the holder paid for) states its cost and its
 *     max loss, which for a long is the cost. Costs and max losses round UP to the cent.
 *   - No promotional language: no exclamation marks, no emoji, no urgency, no yield or return
 *     claims, nothing about what a position "could" make. A payout that happened is reported with
 *     its multiple of the cost, because that is a fact about the past.
 *   - Numbers are formatted as the dapp formats them (format.ts). Prices are USDG per whole share.
 *   - Every message links to the app page where the thing it describes can be seen or acted on:
 *     a series page, Portfolio, Earn for a writer, or the market page for a price alert.
 *
 * App routes (plan W2): /[ticker]/[longId], /[ticker], /portfolio, /earn/[ticker],
 * /settings/notifications. Tickers are upper case, as in the indexer API.
 */
import type { EventPayloads, Money, ParsedEvent, SeriesLite } from './events.js';
import { fmtAsset, fmtEastern, fmtMultiple, fmtShares, fmtUsdg, fmtUsdgUp, shortAddress } from './format.js';

export interface Rendered {
  title: string;
  body: string;
  url: string;
}

const raw = (m: Money): bigint => BigInt(m.raw);
const usdg = (m: Money): string => `${fmtUsdg(raw(m))} USDG`;
const usdgCost = (m: Money): string => `${fmtUsdgUp(raw(m))} USDG`;

function optionName(series: SeriesLite): string {
  return `${series.ticker} ${fmtUsdg(raw(series.strike))} ${series.isPut ? 'put' : 'call'}`;
}

function shares(units: string): string {
  const n = BigInt(units);
  return `${fmtShares(n)} ${n === 100n ? 'share' : 'shares'}`;
}

/** "NVDA settles above 221.00 USDG": the condition under which a long pays. */
function paysIf(series: SeriesLite): string {
  return `${series.ticker} settles ${series.isPut ? 'below' : 'above'} ${usdg(series.strike)}`;
}

/** An amount in the collateral / payout asset: USDG (6 dp) or the market's Stock Tokens (18 dp). */
function assetAmount(amount: Money, ticker: string): string {
  return amount.decimals === 6 ? usdg(amount) : `${fmtAsset(raw(amount))} ${ticker} Stock Tokens`;
}

function costAndMaxLoss(cost: Money): string {
  return `Cost: ${usdgCost(cost)}. Max loss: ${usdgCost(cost)}.`;
}

export interface Links {
  series(series: SeriesLite): string;
  market(ticker: string): string;
  portfolio(): string;
  earn(ticker: string): string;
  settings(): string;
}

export function appLinks(appUrl: string): Links {
  const base = appUrl.replace(/\/+$/, '');
  return {
    series: (s) => `${base}/${encodeURIComponent(s.ticker)}/${s.longId}`,
    market: (ticker) => `${base}/${encodeURIComponent(ticker)}`,
    portfolio: () => `${base}/portfolio`,
    earn: (ticker) => `${base}/earn/${encodeURIComponent(ticker)}`,
    settings: () => `${base}/settings/notifications`,
  };
}

/* --------------------------------------------------------------------------------- per kind */

function fillReceipt(p: EventPayloads['fill_receipt'], links: Links): Rendered {
  const name = optionName(p.series);
  const when = fmtEastern(p.series.expiry);
  if (p.role === 'recipient' && p.side === 'sell' && p.seller !== undefined) {
    // Interface v4, bid hit: another wallet sold and had the USDG paid here. No position is held.
    const seller = shortAddress(p.seller);
    return {
      title: `Received sale proceeds: ${name}`,
      body: [
        `Wallet ${seller} sold ${shares(p.units)} of the ${name} expiring ${when}, at ${usdg(p.price)} per share, and the proceeds were paid to your wallet.`,
        `Received: ${usdg(p.total)}, after ${usdg(p.fee)} in fees.`,
      ].join('\n'),
      url: links.series(p.series),
    };
  }
  if (p.role === 'recipient' && p.payer !== undefined) {
    const payer = shortAddress(p.payer);
    return {
      title: `Received ${name}`,
      body: [
        `Wallet ${payer} bought ${shares(p.units)} of the ${name} expiring ${when} for your wallet, at ${usdg(p.price)} per share.`,
        `Cost: ${usdgCost(p.total)}, paid by ${payer}. Max loss: ${usdgCost(p.total)}.`,
        `It pays out only if ${paysIf(p.series)} at expiry.`,
      ].join('\n'),
      url: links.series(p.series),
    };
  }
  if (p.side === 'buy' && p.recipient !== undefined) {
    const to = shortAddress(p.recipient);
    return {
      title: `Bought ${name} for ${to}`,
      body: [
        `You bought ${shares(p.units)} of the ${name} expiring ${when} for wallet ${to}, at ${usdg(p.price)} per share.`,
        `Cost: ${usdgCost(p.total)}, including ${usdg(p.fee)} in fees. Max loss: ${usdgCost(p.total)}.`,
        `The options are held by ${to}, and any payout goes to that wallet. It pays out only if ${paysIf(p.series)} at expiry.`,
      ].join('\n'),
      url: links.series(p.series),
    };
  }
  if (p.side === 'buy') {
    return {
      title: `Bought ${name}`,
      body: [
        `You bought ${shares(p.units)} of the ${name} expiring ${when}, at ${usdg(p.price)} per share.`,
        `Cost: ${usdgCost(p.total)}, including ${usdg(p.fee)} in fees. Max loss: ${usdgCost(p.total)}.`,
        `It pays out only if ${paysIf(p.series)} at expiry.`,
      ].join('\n'),
      url: links.series(p.series),
    };
  }
  const to = p.recipient === undefined ? null : shortAddress(p.recipient);
  return {
    title: to === null ? `Sold ${name}` : `Sold ${name}, proceeds to ${to}`,
    body: [
      p.primary
        ? `You wrote and sold ${shares(p.units)} of the ${name} expiring ${when}, at ${usdg(p.price)} per share.`
        : `You sold ${shares(p.units)} of the ${name} expiring ${when}, at ${usdg(p.price)} per share.`,
      to === null
        ? `Received: ${usdg(p.total)}, after ${usdg(p.fee)} in fees.`
        : `Proceeds: ${usdg(p.total)}, after ${usdg(p.fee)} in fees, paid to wallet ${to}.`,
      ...(p.primary
        ? [`Your collateral backs these options until they settle. If ${paysIf(p.series)}, holders are paid from it.`]
        : []),
    ].join('\n'),
    url: links.series(p.series),
  };
}

function strikeCross(p: EventPayloads['strike_cross'], links: Links): Rendered {
  const name = optionName(p.series);
  const when = fmtEastern(p.series.expiry);
  const strike = usdg(p.series.strike);
  const where = `${p.series.ticker} is at ${usdg(p.spot)}, ${p.direction} the ${strike} strike`;
  if (p.position === 'long') {
    return {
      title: `${p.series.ticker} is ${p.direction} the strike of your ${name}`,
      body: [
        `${where} of your ${name} expiring ${when} (${shares(p.units)}).`,
        `If ${paysIf(p.series)} at expiry, it pays out. If not, it expires worthless.`,
        // A long payload always carries cost (events.ts refuses one without it).
        costAndMaxLoss(p.cost as Money),
      ].join('\n'),
      url: links.series(p.series),
    };
  }
  return {
    title: `${p.series.ticker} is ${p.direction} the strike of the ${name} you wrote`,
    body: [
      `${where} of the ${name} you wrote, expiring ${when} (${shares(p.units)}).`,
      `If ${paysIf(p.series)} at expiry, holders are paid from your collateral and you get back the rest. You keep the premium either way.`,
    ].join('\n'),
    url: links.series(p.series),
  };
}

function priceAlert(p: EventPayloads['price_alert'], links: Links): Rendered {
  return {
    title: `${p.ticker} is ${p.direction} ${usdg(p.threshold)}`,
    body: `${p.ticker} is at ${usdg(p.spot)}, ${p.direction} your alert at ${usdg(p.threshold)}.`,
    url: links.market(p.ticker),
  };
}

function expiry(p: EventPayloads['expiry_24h'], hoursLabel: string, links: Links): Rendered {
  const name = optionName(p.series);
  const when = fmtEastern(p.series.expiry);
  const spot = p.spot === undefined ? '' : ` ${p.series.ticker} is at ${usdg(p.spot)}.`;
  if (p.position === 'long') {
    return {
      title: `Your ${name} expires in ${hoursLabel}`,
      body: [
        `Your ${name} (${shares(p.units)}) expires ${when}.${spot}`,
        `Settlement is automatic: if ${paysIf(p.series)}, the payout is sent to you. Otherwise it expires worthless.`,
        costAndMaxLoss(p.cost as Money),
      ].join('\n'),
      url: links.series(p.series),
    };
  }
  return {
    title: `The ${name} you wrote expires in ${hoursLabel}`,
    body: [
      `The ${name} you wrote (${shares(p.units)}) expires ${when}.${spot}`,
      `Settlement is automatic: if ${paysIf(p.series)}, holders are paid from your collateral and the rest comes back to you. Otherwise all of your collateral comes back.`,
    ].join('\n'),
    url: links.series(p.series),
  };
}

function settlementReceipt(p: EventPayloads['settlement_receipt'], links: Links): Rendered {
  const name = optionName(p.series);
  const settled = usdg(p.settlementPrice);
  const where = p.toLedger
    ? 'held in your Stonkhouse balance. Withdraw it from Portfolio.'
    : 'sent to your wallet.';

  if (p.position === 'long') {
    const cost = p.cost as Money;
    if (p.payout === null || raw(p.payout.amount) === 0n) {
      return {
        title: `Your ${name} expired worthless`,
        body: [
          `Your ${name} (${shares(p.units)}) expired worthless: ${p.series.ticker} settled at ${settled}, ${p.series.isPut ? 'above' : 'below'} the ${usdg(p.series.strike)} strike.`,
          `You lost the cost, ${usdgCost(cost)}. Max loss: ${usdgCost(cost)}, the most this position could lose.`,
        ].join('\n'),
        url: links.series(p.series),
      };
    }
    const amount = p.payout.amount;
    const inUsdg = p.payout.asset === 'usdg';
    const valued = inUsdg ? raw(amount) : p.payoutValue === undefined ? null : raw(p.payoutValue);
    const multiple = valued === null ? null : fmtMultiple(valued, raw(cost));
    return {
      title: `Your ${name} settled: paid ${inUsdg ? usdg(amount) : assetAmount(amount, p.series.ticker)}`,
      body: [
        `Your ${name} (${shares(p.units)}) settled at ${settled}.`,
        `Paid: ${assetAmount(amount, p.series.ticker)}${!inUsdg && p.payoutValue !== undefined ? ` (${usdg(p.payoutValue)} at the settlement price)` : ''}, ${where}`,
        `${costAndMaxLoss(cost)}${multiple === null ? '' : ` The payout is ${multiple} times the cost.`}`,
      ].join('\n'),
      url: p.toLedger ? links.portfolio() : links.series(p.series),
    };
  }

  const returned =
    p.payout === null || raw(p.payout.amount) === 0n
      ? 'Nothing was returned: all of the collateral paid the holders.'
      : `Returned to you: ${assetAmount(p.payout.amount, p.series.ticker)} of collateral, ${where}`;
  return {
    title: `The ${name} you wrote settled`,
    body: [
      `The ${name} you wrote (${shares(p.units)}) settled at ${settled}.`,
      returned,
      'You keep the premium you received when it sold.',
    ].join('\n'),
    url: p.toLedger ? links.portfolio() : links.earn(p.series.ticker),
  };
}

function writerItmWarning(p: EventPayloads['writer_itm_warning'], links: Links): Rendered {
  const name = optionName(p.series);
  const side = p.series.isPut ? 'below' : 'above';
  return {
    title: `${p.series.ticker} is ${side} the strike of the ${name} you wrote`,
    body: [
      `${p.series.ticker} is at ${usdg(p.spot)}, ${side} the ${usdg(p.series.strike)} strike of the ${name} you wrote (${shares(p.units)}), which expires ${fmtEastern(p.series.expiry)}.`,
      `If ${paysIf(p.series)}, holders are paid from your ${assetAmount(p.collateralLocked, p.series.ticker)} of collateral and you get back the rest. You keep the premium either way.`,
      'You can buy back and close the position before expiry from Earn.',
    ].join('\n'),
    url: links.earn(p.series.ticker),
  };
}

function autoRoll(p: EventPayloads['auto_roll'], links: Links): Rendered {
  if (p.status === 'rolled' && p.series !== undefined && p.price !== undefined && p.units !== undefined) {
    const name = optionName(p.series);
    return {
      title: `Auto-roll listed your next ${p.ticker} ${p.series.isPut ? 'put' : 'call'}`,
      body: [
        `Auto-roll listed ${shares(p.units)} of the ${name} expiring ${fmtEastern(p.series.expiry)} at ${usdg(p.price)} per share.`,
        'Premium is paid only if a buyer fills. Your collateral backs the options until they settle.',
      ].join('\n'),
      url: links.earn(p.ticker),
    };
  }
  if (p.status === 'withdrawn' && p.series !== undefined && p.spot !== undefined && p.nextRollAfter !== undefined) {
    const name = optionName(p.series);
    return {
      title: `Auto-roll withdrew your ${p.ticker} ask`,
      body: [
        `${p.ticker} reached the ${usdg(p.series.strike)} strike (spot ${usdg(p.spot)}${p.spotUpdatedAt === undefined ? '' : ` at ${fmtEastern(p.spotUpdatedAt)}`}), so auto-roll withdrew the unsold part of your ${name} ask.`,
        'That stops it selling for less than the option is now worth. Options already sold are unchanged, and your collateral still backs them.',
        `Auto-roll lists again after the ${fmtEastern(p.nextRollAfter)} expiry.`,
      ].join('\n'),
      url: links.earn(p.ticker),
    };
  }
  const last = p.lastRolledAt === undefined ? null : fmtEastern(p.lastRolledAt);
  return {
    title: `Auto-roll has not rolled your ${p.ticker} position`,
    body: [
      ...(p.dueAt === undefined
        ? // A payload queued before dueAt existed.
          [`Auto-roll has not rolled your ${p.ticker} position for more than 24 hours${last === null ? '' : ` (last roll ${last})`}.`]
        : [
            `Auto-roll has not rolled your ${p.ticker} position. The roll was due when the session opened ${fmtEastern(p.dueAt)}, more than 24 hours ago.`,
            ...(last === null ? [] : [`Last roll: ${last}.`]),
          ]),
      'Nothing new is listed for sale until it rolls. Check the strategy on Earn.',
    ].join('\n'),
    url: links.earn(p.ticker),
  };
}

function payoutFailedToLedger(p: EventPayloads['payout_failed_to_ledger'], links: Links): Rendered {
  return {
    title: 'Payout held in your Stonkhouse balance',
    body: [
      `A payout of ${assetAmount(p.amount, p.series.ticker)} from your ${optionName(p.series)} could not be sent to your wallet, so it is held in your Stonkhouse balance.`,
      'Withdraw it from Portfolio.',
    ].join('\n'),
    url: links.portfolio(),
  };
}

/** Render a validated event (events.ts parsePayload). Pure. */
export function render(event: ParsedEvent, links: Links): Rendered {
  switch (event.kind) {
    case 'fill_receipt':
      return fillReceipt(event.payload, links);
    case 'strike_cross':
      return strikeCross(event.payload, links);
    case 'price_alert':
      return priceAlert(event.payload, links);
    case 'expiry_24h':
      return expiry(event.payload, '24 hours', links);
    case 'expiry_1h':
      return expiry(event.payload, '1 hour', links);
    case 'settlement_receipt':
      return settlementReceipt(event.payload, links);
    case 'writer_itm_warning':
      return writerItmWarning(event.payload, links);
    case 'auto_roll':
      return autoRoll(event.payload, links);
    case 'payout_failed_to_ledger':
      return payoutFailedToLedger(event.payload, links);
  }
}
