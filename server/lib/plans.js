'use strict';
/* Plans, limits and the guard that stops a free user costing you money. */

const PLANS = {
  free: {
    name: 'Free',
    maxAlarms: 3,
    instant: false,
    digest: true,
    channels: ['email'],
    maxAlertsPerMonth: 0,      // no instant alerts at all; digest only
    priceInr: 0
  },
  whatsapp: {
    name: 'WhatsApp',
    maxAlarms: 10,
    instant: true,
    digest: false,
    channels: ['email', 'whatsapp'],
    maxAlertsPerMonth: 100,    // 100 x ₹0.115 ≈ ₹11.50 worst case
    priceInr: 100,
    durationDays: 365
  }
};

function planFor(user) {
  const p = PLANS[user.plan] || PLANS.free;
  if (user.planExpiresAt && Date.now() > user.planExpiresAt) return PLANS.free;
  return p;
}

/** Can this user add another alarm? Returns {ok, reason}. */
function canAddAlarm(user, currentCount) {
  const plan = planFor(user);
  if (currentCount >= plan.maxAlarms) {
    return {
      ok: false,
      reason: `Your plan allows ${plan.maxAlarms} alarms. ${plan.maxAlarms === 3 ? 'Get WhatsApp for 10.' : 'Delete one to add another.'}`
    };
  }
  return { ok: true };
}

/** May we send an instant alert right now? Checks plan, channel and the monthly cap. */
function canAlert(user, sentThisMonth, channel) {
  const plan = planFor(user);
  if (!plan.instant) return { ok: false, reason: 'free plan is digest-only' };
  if (!plan.channels.includes(channel)) return { ok: false, reason: 'channel not on this plan' };
  if (sentThisMonth >= plan.maxAlertsPerMonth) {
    return { ok: false, reason: `monthly cap of ${plan.maxAlertsPerMonth} alerts reached` };
  }
  return { ok: true };
}

/** What this user is allowed to pick in the channel dropdown. */
function channelsFor(user) {
  return planFor(user).channels;
}

module.exports = { PLANS, planFor, canAddAlarm, canAlert, channelsFor };
