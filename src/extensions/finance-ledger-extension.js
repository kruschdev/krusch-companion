import { getDb, createTask, today } from '../db/index.js';

/**
 * Subscriptions, Recurring Bills & Receipt Ledger Extension
 *
 * Enforces Invariant INV-EXT-06 (Zero-Token Sentinel Channel 5 — Subscription Renewal Watchdog):
 *   - Scans active `companion_subscriptions` with `auto_renew = 1` on CPU ($0.00 / 0 LLM tokens).
 *   - Triggers only when `next_renewal_date` is within `[0, daysAhead]` days and
 *     `last_notified_renewal !== next_renewal_date`.
 *   - Updates `last_notified_renewal = next_renewal_date` to guarantee idempotency across Sentinel ticks
 *     and stages a Priority 1 task (`execution_priority: 1`, `pillar: 'Provision & Finance'`) on Today's Board.
 */

function addDaysToIsoDate(baseDateStr, days) {
  const cleanBase = String(baseDateStr || today()).slice(0, 10);
  const dt = new Date(`${cleanBase}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) {
    return today();
  }
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().split('T')[0];
}

function diffDaysBetweenIsoDates(fromDateStr, toDateStr) {
  const fromClean = String(fromDateStr || today()).slice(0, 10);
  const toClean = String(toDateStr || '').slice(0, 10);
  const fromDt = new Date(`${fromClean}T00:00:00Z`);
  const toDt = new Date(`${toClean}T00:00:00Z`);
  if (Number.isNaN(fromDt.getTime()) || Number.isNaN(toDt.getTime())) {
    return null;
  }
  return Math.round((toDt.getTime() - fromDt.getTime()) / (1000 * 60 * 60 * 24));
}

function normalizeMonthlyEquivalent(amount, billingCycle = 'monthly') {
  const num = Number(amount) || 0;
  const cycle = String(billingCycle || 'monthly').toLowerCase().trim();
  if (cycle === 'annual' || cycle === 'yearly' || cycle === 'year') {
    return num / 12;
  }
  if (cycle === 'quarterly' || cycle === 'quarter') {
    return num / 3;
  }
  if (cycle === 'weekly' || cycle === 'week') {
    return (num * 52) / 12;
  }
  if (cycle === 'biweekly' || cycle === 'bi-weekly') {
    return (num * 26) / 12;
  }
  return num;
}

function normalizeAnnualEquivalent(amount, billingCycle = 'monthly') {
  const num = Number(amount) || 0;
  const cycle = String(billingCycle || 'monthly').toLowerCase().trim();
  if (cycle === 'annual' || cycle === 'yearly' || cycle === 'year') {
    return num;
  }
  if (cycle === 'quarterly' || cycle === 'quarter') {
    return num * 4;
  }
  if (cycle === 'weekly' || cycle === 'week') {
    return num * 52;
  }
  if (cycle === 'biweekly' || cycle === 'bi-weekly') {
    return num * 26;
  }
  return num * 12;
}

/**
 * Ensure `companion_subscriptions` and `companion_receipts` tables exist
 * and seed 3 baseline subscriptions when `companion_subscriptions` is empty.
 */
export function ensureFinanceLedgerTables() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS companion_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      billing_cycle TEXT DEFAULT 'monthly',
      next_renewal_date TEXT NOT NULL,
      category TEXT DEFAULT 'software',
      auto_renew INTEGER DEFAULT 1,
      cancel_url TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      notes TEXT DEFAULT '',
      last_notified_renewal TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companion_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      category TEXT DEFAULT 'Provision & Finance',
      receipt_date TEXT NOT NULL,
      payment_method TEXT DEFAULT 'card',
      mandate_id TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const existingCount = database
    .prepare('SELECT COUNT(*) as count FROM companion_subscriptions')
    .get().count;

  if (existingCount === 0) {
    const baseDate = today();
    const insertSub = database.prepare(`
      INSERT INTO companion_subscriptions (
        name, amount, currency, billing_cycle, next_renewal_date,
        category, auto_renew, cancel_url, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `);

    insertSub.run(
      'Seattle City Light Utility',
      118.5,
      'USD',
      'monthly',
      addDaysToIsoDate(baseDate, 6),
      'utility',
      1,
      'https://myutilities.seattle.gov',
      'Household electricity & utility billing'
    );
    insertSub.run(
      'Cloud Backup Storage',
      9.99,
      'USD',
      'monthly',
      addDaysToIsoDate(baseDate, 14),
      'software',
      1,
      'https://cloud.example.com/billing/cancel',
      'Encrypted off-site family photo & vault backup'
    );
    insertSub.run(
      'Local Gym Membership',
      45.0,
      'USD',
      'monthly',
      addDaysToIsoDate(baseDate, 21),
      'health',
      1,
      'https://gym.example.com/account/membership',
      'Monthly fitness & wellness membership'
    );
  }
}

/**
 * Create or update a recurring subscription or utility bill.
 */
export function upsertSubscription({
  name,
  amount,
  currency = 'USD',
  billingCycle = 'monthly',
  nextRenewalDate,
  category = 'subscription',
  autoRenew = true,
  cancelUrl = '',
  notes = ''
} = {}) {
  ensureFinanceLedgerTables();
  const database = getDb();

  const cleanName = String(name || 'Unnamed Subscription').trim();
  const cleanAmount = Number.isFinite(Number(amount)) ? Number(Number(amount).toFixed(2)) : 0;
  const cleanCurrency = String(currency || 'USD').toUpperCase().trim() || 'USD';
  const cleanCycle = String(billingCycle || 'monthly').toLowerCase().trim() || 'monthly';
  const cleanRenewalDate = String(nextRenewalDate || addDaysToIsoDate(today(), 30)).slice(0, 10);
  const cleanCategory = String(category || 'subscription').trim() || 'subscription';
  const cleanAutoRenew = autoRenew === false || autoRenew === 0 ? 0 : 1;
  const cleanCancelUrl = String(cancelUrl || '').trim();
  const cleanNotes = String(notes || '').trim();

  const existing = database
    .prepare('SELECT * FROM companion_subscriptions WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1')
    .get(cleanName);

  if (existing) {
    const renewalChanged = existing.next_renewal_date !== cleanRenewalDate;
    database
      .prepare(`
        UPDATE companion_subscriptions
        SET amount = ?,
            currency = ?,
            billing_cycle = ?,
            next_renewal_date = ?,
            category = ?,
            auto_renew = ?,
            cancel_url = ?,
            status = 'active',
            notes = ?,
            last_notified_renewal = CASE WHEN ? THEN NULL ELSE last_notified_renewal END,
            updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(
        cleanAmount,
        cleanCurrency,
        cleanCycle,
        cleanRenewalDate,
        cleanCategory,
        cleanAutoRenew,
        cleanCancelUrl || existing.cancel_url || '',
        cleanNotes || existing.notes || '',
        renewalChanged ? 1 : 0,
        existing.id
      );

    return database
      .prepare('SELECT * FROM companion_subscriptions WHERE id = ?')
      .get(existing.id);
  }

  const info = database
    .prepare(`
      INSERT INTO companion_subscriptions (
        name, amount, currency, billing_cycle, next_renewal_date,
        category, auto_renew, cancel_url, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `)
    .run(
      cleanName,
      cleanAmount,
      cleanCurrency,
      cleanCycle,
      cleanRenewalDate,
      cleanCategory,
      cleanAutoRenew,
      cleanCancelUrl,
      cleanNotes
    );

  return database
    .prepare('SELECT * FROM companion_subscriptions WHERE id = ?')
    .get(info.lastInsertRowid);
}

/**
 * Cancel a subscription by `id` or `name`, marking `status = 'cancelled'` and `auto_renew = 0`.
 */
export function cancelSubscription({ id = null, name = '' } = {}) {
  ensureFinanceLedgerTables();
  const database = getDb();

  let target = null;
  if (id !== null && id !== undefined && String(id).trim() !== '') {
    target = database
      .prepare('SELECT * FROM companion_subscriptions WHERE id = ?')
      .get(Number(id));
  }

  if (!target && name) {
    const cleanName = String(name).trim();
    target =
      database
        .prepare('SELECT * FROM companion_subscriptions WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1')
        .get(cleanName) ||
      database
        .prepare('SELECT * FROM companion_subscriptions WHERE lower(name) LIKE ? ORDER BY id DESC LIMIT 1')
        .get(`%${cleanName.toLowerCase()}%`);
  }

  if (!target) {
    return null;
  }

  database
    .prepare(`
      UPDATE companion_subscriptions
      SET status = 'cancelled',
          auto_renew = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(target.id);

  return database
    .prepare('SELECT * FROM companion_subscriptions WHERE id = ?')
    .get(target.id);
}

/**
 * Log a one-off receipt or expense into `companion_receipts`.
 */
export function recordReceiptExpense({
  merchant,
  amount,
  currency = 'USD',
  category = 'Provision & Finance',
  receiptDate = null,
  paymentMethod = 'card',
  mandateId = '',
  notes = ''
} = {}) {
  ensureFinanceLedgerTables();
  const database = getDb();

  const cleanMerchant = String(merchant || 'General Merchant').trim();
  const cleanAmount = Number.isFinite(Number(amount)) ? Number(Number(amount).toFixed(2)) : 0;
  const cleanCurrency = String(currency || 'USD').toUpperCase().trim() || 'USD';
  const cleanCategory = String(category || 'Provision & Finance').trim() || 'Provision & Finance';
  const cleanDate = String(receiptDate || today()).slice(0, 10);
  const cleanMethod = String(paymentMethod || 'card').trim() || 'card';
  const cleanMandateId = String(mandateId || '').trim();
  const cleanNotes = String(notes || '').trim();

  const info = database
    .prepare(`
      INSERT INTO companion_receipts (
        merchant, amount, currency, category, receipt_date, payment_method, mandate_id, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      cleanMerchant,
      cleanAmount,
      cleanCurrency,
      cleanCategory,
      cleanDate,
      cleanMethod,
      cleanMandateId,
      cleanNotes
    );

  return database
    .prepare('SELECT * FROM companion_receipts WHERE id = ?')
    .get(info.lastInsertRowid);
}

/**
 * List tracked subscriptions and recurring bills filtered by status (default: 'active').
 */
export function listSubscriptionsAndBills({ status = 'active' } = {}) {
  ensureFinanceLedgerTables();
  const database = getDb();

  const cleanStatus = status ? String(status).toLowerCase().trim() : 'active';
  const rows =
    cleanStatus === 'all'
      ? database
          .prepare('SELECT * FROM companion_subscriptions ORDER BY next_renewal_date ASC, id ASC')
          .all()
      : database
          .prepare('SELECT * FROM companion_subscriptions WHERE status = ? ORDER BY next_renewal_date ASC, id ASC')
          .all(cleanStatus);

  const receipts = database
    .prepare('SELECT * FROM companion_receipts ORDER BY receipt_date DESC, id DESC LIMIT 25')
    .all();

  Object.defineProperty(rows, 'subscriptions', { value: rows, enumerable: false });
  Object.defineProperty(rows, 'receipts', { value: receipts, enumerable: false });
  return rows;
}

/**
 * Calculate monthly recurring burn (`monthlyRecurringTotal`), annualized recurring projection
 * (`annualRecurringTotal`), total logged receipts for the current month (`monthlyReceiptsTotal`),
 * and upcoming renewals within 7 days.
 */
export function getMonthlyFinanceSummary({ referenceDate = null } = {}) {
  ensureFinanceLedgerTables();
  const database = getDb();
  const refDate = String(referenceDate || today()).slice(0, 10);
  const currentMonthPrefix = refDate.slice(0, 7); // YYYY-MM

  const activeSubscriptions = database
    .prepare("SELECT * FROM companion_subscriptions WHERE status = 'active' ORDER BY next_renewal_date ASC, id ASC")
    .all();

  let monthlyRecurringRaw = 0;
  let annualRecurringRaw = 0;
  const upcomingRenewals = [];

  for (const sub of activeSubscriptions) {
    monthlyRecurringRaw += normalizeMonthlyEquivalent(sub.amount, sub.billing_cycle);
    annualRecurringRaw += normalizeAnnualEquivalent(sub.amount, sub.billing_cycle);

    const daysUntil = diffDaysBetweenIsoDates(refDate, sub.next_renewal_date);
    if (daysUntil !== null && daysUntil >= 0 && daysUntil <= 7) {
      upcomingRenewals.push({
        ...sub,
        daysUntilRenewal: daysUntil
      });
    }
  }

  const monthlyReceiptsRow = database
    .prepare('SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM companion_receipts WHERE receipt_date LIKE ?')
    .get(`${currentMonthPrefix}%`);

  const monthlyRecurringTotal = Number(monthlyRecurringRaw.toFixed(2));
  const annualRecurringTotal = Number(annualRecurringRaw.toFixed(2));
  const monthlyReceiptsTotal = Number(Number(monthlyReceiptsRow?.total || 0).toFixed(2));

  return {
    referenceDate: refDate,
    month: currentMonthPrefix,
    activeSubscriptionsCount: activeSubscriptions.length,
    monthlyRecurringTotal,
    monthlyTotal: monthlyRecurringTotal,
    annualRecurringTotal,
    monthlyReceiptsTotal,
    monthlyReceiptsCount: Number(monthlyReceiptsRow?.count || 0),
    combinedMonthlyOutflow: Number((monthlyRecurringTotal + monthlyReceiptsTotal).toFixed(2)),
    upcomingRenewals,
    upcomingRenewalsCount: upcomingRenewals.length,
    subscriptions: activeSubscriptions
  };
}

/**
 * Invariant INV-EXT-06: Zero-Token Sentinel Channel 5 — Subscription Renewal Watchdog.
 *
 * Scans active `companion_subscriptions` with `auto_renew = 1` whose `next_renewal_date`
 * is within `[0, daysAhead]` days from `referenceDate || today()` and where
 * `last_notified_renewal !== next_renewal_date`.
 *
 * Updates `last_notified_renewal = next_renewal_date`, stages a Priority 1 task
 * (`execution_priority: 1`, `pillar: 'Provision & Finance'`) on Today's Board,
 * and returns anomaly descriptors ready for `runSentinelTick()`.
 */
export function evaluateSubscriptionRenewalAnomalies({ daysAhead = 3, referenceDate = null } = {}) {
  ensureFinanceLedgerTables();
  const database = getDb();
  const refDate = String(referenceDate || today()).slice(0, 10);
  const windowDays = Number.isFinite(Number(daysAhead)) ? Math.max(0, Number(daysAhead)) : 3;

  const activeAutoRenewSubs = database
    .prepare(`
      SELECT * FROM companion_subscriptions
      WHERE status = 'active' AND auto_renew = 1
      ORDER BY next_renewal_date ASC, id ASC
    `)
    .all();

  const anomalies = [];
  const updateNotifiedStmt = database.prepare(`
    UPDATE companion_subscriptions
    SET last_notified_renewal = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const sub of activeAutoRenewSubs) {
    if (sub.last_notified_renewal === sub.next_renewal_date) {
      continue;
    }

    const daysUntilRenewal = diffDaysBetweenIsoDates(refDate, sub.next_renewal_date);
    if (daysUntilRenewal === null || daysUntilRenewal < 0 || daysUntilRenewal > windowDays) {
      continue;
    }

    updateNotifiedStmt.run(sub.next_renewal_date, sub.id);

    const formattedAmount = Number(sub.amount || 0).toFixed(2);
    const taskTitle = `💳 [Auto-Renewal in ${daysUntilRenewal}d] ${sub.name} ($${formattedAmount})`;
    const noteParts = [
      `Subscription auto-renews on ${sub.next_renewal_date} (${sub.billing_cycle || 'monthly'} • $${formattedAmount} ${sub.currency || 'USD'}).`
    ];
    if (sub.cancel_url) {
      noteParts.push(`Cancel / Manage URL: ${sub.cancel_url}`);
    }
    if (sub.notes) {
      noteParts.push(sub.notes);
    }

    const stagedTask = createTask({
      title: taskTitle,
      priority_id: 5,
      execution_priority: 1,
      pillar: 'Provision & Finance',
      notes: noteParts.join('\n'),
      energy_level: 'low',
      date: refDate
    });

    const headline = `Subscription Auto-Renewal in ${daysUntilRenewal}d: ${sub.name} ($${formattedAmount}/${sub.billing_cycle || 'monthly'})`;

    anomalies.push({
      subscriptionId: sub.id,
      name: sub.name,
      amount: Number(sub.amount),
      currency: sub.currency || 'USD',
      billingCycle: sub.billing_cycle || 'monthly',
      nextRenewalDate: sub.next_renewal_date,
      daysUntilRenewal,
      cancelUrl: sub.cancel_url || '',
      stagedTaskId: stagedTask?.id || null,
      headline
    });
  }

  return anomalies;
}

/**
 * Opt-in Subscriptions, Recurring Bills & Receipt Ledger Tool Definition.
 */
export const FINANCE_LEDGER_EXTENSION_TOOL = {
  name: 'finance_subscription_ledger',
  category: 'finance_ledger',
  extensionId: 'finance-subscription-ledger',
  description:
    'Opt-in Subscriptions, Recurring Bills & Receipt Ledger: track recurring subscriptions and utilities, log receipt expenses, calculate monthly burn rate, or scan for 3-day auto-renewal alerts.',
  parameters: {
    action:
      'string (REQUIRED: "summary" | "upsert_subscription" | "cancel_subscription" | "log_receipt" | "check_renewals" | "list")',
    name: 'string (Subscription, bill, or merchant name)',
    amount: 'number (Dollar amount, e.g. 19.99)',
    billingCycle: 'string ("monthly" | "annual" | "weekly" | "quarterly")',
    nextRenewalDate: 'string (YYYY-MM-DD renewal or due date)',
    cancelUrl: 'string (Direct cancellation URL if known)',
    notes: 'string (Optional notes or line items)'
  },
  required: ['action'],
  async execute(args = {}) {
    ensureFinanceLedgerTables();
    const action = String(args?.action || 'summary').toLowerCase().trim();

    if (action === 'upsert_subscription' || action === 'add_subscription' || action === 'create_subscription') {
      const sub = upsertSubscription({
        name: args.name || args.merchant || 'Subscription',
        amount: args.amount ?? 0,
        currency: args.currency || 'USD',
        billingCycle: args.billingCycle || args.billing_cycle || 'monthly',
        nextRenewalDate: args.nextRenewalDate || args.next_renewal_date || addDaysToIsoDate(today(), 30),
        category: args.category || 'subscription',
        autoRenew: args.autoRenew !== undefined ? args.autoRenew : true,
        cancelUrl: args.cancelUrl || args.cancel_url || '',
        notes: args.notes || ''
      });
      return {
        ok: true,
        tool: 'finance_subscription_ledger',
        actionType: 'upsert_subscription',
        summary: `💳 **Saved Subscription**: **${sub.name}** ($${Number(sub.amount).toFixed(2)}/${sub.billing_cycle}) — Next renewal on \`${sub.next_renewal_date}\`.`,
        data: { subscription: sub }
      };
    }

    if (action === 'cancel_subscription') {
      const cancelled = cancelSubscription({
        id: args.id ?? null,
        name: args.name || args.merchant || ''
      });
      if (!cancelled) {
        return {
          ok: true,
          tool: 'finance_subscription_ledger',
          actionType: 'cancel_subscription',
          summary: `ℹ️ No matching subscription found for "${args.name || args.id || ''}".`,
          data: { cancelled: false, subscription: null }
        };
      }
      return {
        ok: true,
        tool: 'finance_subscription_ledger',
        actionType: 'cancel_subscription',
        summary: `🛑 **Cancelled Subscription**: **${cancelled.name}** ($${Number(cancelled.amount).toFixed(2)}/${cancelled.billing_cycle}) marked as \`cancelled\` with \`auto_renew = 0\`.`,
        data: { cancelled: true, subscription: cancelled }
      };
    }

    if (action === 'log_receipt') {
      const receipt = recordReceiptExpense({
        merchant: args.merchant || args.name || 'Merchant',
        amount: args.amount ?? 0,
        currency: args.currency || 'USD',
        category: args.category || 'Provision & Finance',
        receiptDate: args.receiptDate || args.receipt_date || args.nextRenewalDate || today(),
        paymentMethod: args.paymentMethod || args.payment_method || 'card',
        mandateId: args.mandateId || args.mandate_id || '',
        notes: args.notes || ''
      });
      return {
        ok: true,
        tool: 'finance_subscription_ledger',
        actionType: 'log_receipt',
        summary: `🧾 **Logged Receipt Expense**: **${receipt.merchant}** — **$${Number(receipt.amount).toFixed(2)} ${receipt.currency}** on \`${receipt.receipt_date}\`.`,
        data: { receipt }
      };
    }

    if (action === 'check_renewals' || action === 'renewal_alerts') {
      const anomalies = evaluateSubscriptionRenewalAnomalies({
        daysAhead: args.daysAhead ?? 3,
        referenceDate: args.referenceDate || null
      });
      const summaryText =
        anomalies.length > 0
          ? `🚨 **Detected ${anomalies.length} Upcoming Auto-Renewal(s)**:\n` +
            anomalies
              .map(
                a =>
                  `- **${a.name}** ($${Number(a.amount).toFixed(2)}/${a.billingCycle}) renews in **${a.daysUntilRenewal}d** (\`${a.nextRenewalDate}\`) -> Staged Priority 1 Task #${a.stagedTaskId}`
              )
              .join('\n')
          : '✅ **No imminent auto-renewals** within the 3-day watchdog window.';
      return {
        ok: true,
        tool: 'finance_subscription_ledger',
        actionType: 'check_renewals',
        summary: summaryText,
        data: { anomalies, count: anomalies.length }
      };
    }

    if (action === 'list' || action === 'list_subscriptions') {
      const subscriptions = listSubscriptionsAndBills({
        status: args.status || 'active'
      });
      const lines =
        subscriptions.length > 0
          ? subscriptions.map(
              s =>
                `- **${s.name}**: $${Number(s.amount).toFixed(2)}/${s.billing_cycle} • Renews \`${s.next_renewal_date}\` (${s.status})`
            )
          : ['- No active subscriptions found.'];
      return {
        ok: true,
        tool: 'finance_subscription_ledger',
        actionType: 'list',
        summary: `📋 **Tracked Subscriptions & Bills (${subscriptions.length})**:\n${lines.join('\n')}`,
        data: {
          count: subscriptions.length,
          subscriptions: [...subscriptions],
          receipts: subscriptions.receipts || []
        }
      };
    }

    // Default / "summary"
    const summaryData = getMonthlyFinanceSummary({
      referenceDate: args.referenceDate || null
    });
    return {
      ok: true,
      tool: 'finance_subscription_ledger',
      actionType: 'summary',
      summary:
        `📊 **Monthly Finance & Subscription Summary (${summaryData.month})**:\n` +
        `- **Monthly Recurring Burn**: **$${summaryData.monthlyRecurringTotal.toFixed(2)}/mo** (${summaryData.activeSubscriptionsCount} active)\n` +
        `- **Annualized Projection**: **$${summaryData.annualRecurringTotal.toFixed(2)}/yr**\n` +
        `- **Monthly Logged Receipts**: **$${summaryData.monthlyReceiptsTotal.toFixed(2)}** (${summaryData.monthlyReceiptsCount} receipts)\n` +
        `- **Upcoming Renewals (7d)**: **${summaryData.upcomingRenewalsCount}**`,
      data: summaryData
    };
  }
};
