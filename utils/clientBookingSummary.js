"use strict";

// Explicit field projection for the authenticated client list view.
// The full booking detail endpoint intentionally retains its existing contract.
const CLIENT_BOOKING_SUMMARY_SELECT = [
  '_id', 'bookingReference', 'containerNumber', 'containerSize', 'containerType',
  'status', 'billingStatus', 'createdAt', 'submittedAt', 'inDate',
  'expectedArrivalDate', 'outDate', 'assignedArea', 'billingStage', 'recordSource',
  'billingTotal', 'paymentAmount', 'paymentBalanceDue', 'paymentSubmittedAt',
  'paymentDate', 'paymentReferenceNumber', 'receiptNumber',
  'paymentTransactions.paymentStage', 'paymentTransactions.amount',
].join(' ');

const CLIENT_BOOKING_SUMMARY_FIELDS = Object.freeze([
  'id', 'bookingReference', 'containerNumber', 'containerSize', 'containerType',
  'status', 'billingStatus', 'createdAt', 'inDate', 'expectedArrivalDate',
  'outDate', 'assignedAreaName', 'gateInBillingTotal', 'gateOutBillingTotal',
  'totalBillingAmount', 'totalPaidAmount', 'paymentAmount', 'paymentBalanceDue',
  'paymentSubmittedAt', 'paymentDate', 'paymentReferenceNumber', 'receiptNumber',
]);

function toClientBookingSummary(fullBooking) {
  const result = {};
  for (const field of CLIENT_BOOKING_SUMMARY_FIELDS) {
    result[field] = fullBooking[field] ?? null;
  }
  result.paymentTransactionCount = Array.isArray(fullBooking.paymentTransactions)
    ? fullBooking.paymentTransactions.length : 0;
  return result;
}

module.exports = {
  CLIENT_BOOKING_SUMMARY_SELECT,
  CLIENT_BOOKING_SUMMARY_FIELDS,
  toClientBookingSummary,
};
