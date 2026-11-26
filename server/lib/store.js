'use strict';
/* Tiny JSON store. One file, atomic writes, no dependencies. */

const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

const EMPTY = { users: {}, alarms: {}, orders: {}, events: {}, counters: {} };

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const k of Object.keys(EMPTY)) if (!db[k]) db[k] = {};
  } catch {
    db = JSON.parse(JSON.stringify(EMPTY));
  }
  return db;
}

let writing = false;
function save() {
  if (writing) return;
  writing = true;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 1));
    fs.renameSync(tmp, FILE);          // atomic on the same filesystem
  } finally {
    writing = false;
  }
}

const id = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---- users ---- */
function userKey({ phone, email }) {
  if (phone) return 'p:' + String(phone).replace(/\D/g, '').slice(-12);
  if (email) return 'e:' + String(email).trim().toLowerCase();
  return null;
}

function getOrCreateUser(identity) {
  const d = load();
  const key = userKey(identity);
  if (!key) throw new Error('a phone or email is required');
  if (!d.users[key]) {
    d.users[key] = {
      id: id('usr'),
      phone: identity.phone || null,
      email: identity.email || null,
      plan: 'free',
      planExpiresAt: null,
      alertsThisMonth: {},
      createdAt: Date.now()
    };
    save();
  }
  return d.users[key];
}

function getUser(key) {
  return load().users[key] || null;
}

function updateUser(key, patch) {
  const u = load().users[key];
  if (!u) return null;
  Object.assign(u, patch);
  save();
  return u;
}

/* ---- alarms ---- */
function alarmsFor(key) {
  const d = load();
  return Object.values(d.alarms).filter((a) => a.userKey === key);
}

function createAlarm(key, alarm) {
  const d = load();
  const a = {
    id: id('alm'),
    userKey: key,
    type: alarm.type,
    what: alarm.what,
    url: alarm.url || null,
    when: alarm.when,
    freqMinutes: alarm.freqMinutes || 360,
    channel: alarm.channel || 'email',
    active: true,
    lastHash: null,
    lastText: null,
    lastCheckedAt: null,
    lastAlertAt: null,
    createdAt: Date.now()
  };
  d.alarms[a.id] = a;
  save();
  return a;
}

function getAlarm(alarmId) {
  return load().alarms[alarmId] || null;
}

function deleteAlarm(alarmId, userKey) {
  const d = load();
  const a = d.alarms[alarmId];
  if (!a || a.userKey !== userKey) return false;
  delete d.alarms[alarmId];
  save();
  return true;
}

function saveAlarm(a) {
  const d = load();
  d.alarms[a.id] = a;
  save();
}

function dueAlarms(now) {
  return Object.values(load().alarms).filter((a) => {
    if (!a.active || !a.url) return false;
    const since = a.lastCheckedAt || 0;
    return now - since >= a.freqMinutes * 60 * 1000;
  });
}

/* ---- orders and webhook idempotency ---- */
function createOrder(o) {
  const d = load();
  d.orders[o.orderId] = { ...o, createdAt: Date.now() };
  save();
  return d.orders[o.orderId];
}

function getOrder(orderId) {
  return load().orders[orderId] || null;
}

function markOrderPaid(orderId, paymentId) {
  const d = load();
  const o = d.orders[orderId];
  if (!o) return null;
  o.paid = true;
  o.paymentId = paymentId;
  o.paidAt = Date.now();
  save();
  return o;
}

function seenEvent(eventId) {
  const d = load();
  if (d.events[eventId]) return true;
  d.events[eventId] = Date.now();
  save();
  return false;
}

/* ---- monthly message counter, the thing that protects the bill ---- */
function monthKey(d = new Date()) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function alertsSentThisMonth(user) {
  return user.alertsThisMonth?.[monthKey()] || 0;
}

function recordAlert(user) {
  const d = load();
  const u = d.users[userKey(user)] || Object.values(d.users).find((x) => x.id === user.id);
  if (!u) return 0;
  const k = monthKey();
  u.alertsThisMonth = u.alertsThisMonth || {};
  u.alertsThisMonth[k] = (u.alertsThisMonth[k] || 0) + 1;
  save();
  return u.alertsThisMonth[k];
}

function reset() {
  db = JSON.parse(JSON.stringify(EMPTY));
  save();
}

module.exports = {
  load, save, id, userKey, getOrCreateUser, getUser, updateUser,
  alarmsFor, createAlarm, getAlarm, deleteAlarm, saveAlarm, dueAlarms,
  createOrder, getOrder, markOrderPaid, seenEvent,
  alertsSentThisMonth, recordAlert, monthKey, reset,
  FILE
};
