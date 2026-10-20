"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const { toClientBookingSummary, CLIENT_BOOKING_SUMMARY_SELECT } = require('../utils/clientBookingSummary.js');

test('list summary excludes documents, private notes and detailed transaction data', () => {
  const original = {
    id: 'booking1', bookingReference: 'BK-1', status: 'gate_out_requested',
    containerNumber: 'ABCD1234567', documents: [{url:'private'}],
    clientEmail: 'private@example.test', driverLicenseNumber:'SENSITIVE',
    paymentTransactions: [{id:'one', proofs:[{url:'private'}]}, {id:'two'}],
    billingLineItems: [{description:'Private charge'}],
  };
  const summary = toClientBookingSummary(original);
  assert.equal(summary.id, 'booking1');
  assert.equal(summary.bookingReference, 'BK-1');
  assert.equal(summary.paymentTransactionCount, 2);
  for (const key of ['documents','clientEmail','driverLicenseNumber','paymentTransactions','billingLineItems']) {
    assert.equal(Object.hasOwn(summary,key), false, `Unexpected ${key}`);
  }
});

test('projection never requests whole document or file payloads', () => {
  const projection = CLIENT_BOOKING_SUMMARY_SELECT.split(' ');
  assert(projection.includes('paymentTransactions.amount'));
  assert(!projection.includes('paymentTransactions'));
  assert(!projection.includes('documents'));
  assert(!projection.includes('paymentProofs'));
});

test('summary includes fields necessary for client booking cards and gate-out eligibility', () => {
  const summary = toClientBookingSummary({id:'1', status:'stored_in_assigned_area', outDate:null, billingStatus:'pending', paymentBalanceDue:100});
  assert.equal(summary.status,'stored_in_assigned_area');
  assert.equal(summary.paymentBalanceDue,100);
  assert.equal(summary.paymentTransactionCount,0);
});
