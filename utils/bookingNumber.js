"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildBookingNumber = void 0;
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const PreAdvice_js_1 = __importDefault(require("../models/PreAdvice.js"));
const buildBookingNumber = async () => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dateCode = `${yyyy}${mm}${dd}`;
    const prefix = `BN-${dateCode}-`;
    const [bookingCount, preAdviceCount] = await Promise.all([
        Booking_js_1.default.countDocuments({ bookingNumber: { $regex: `^${prefix}` } }),
        PreAdvice_js_1.default.countDocuments({ bookingNumber: { $regex: `^${prefix}` } }),
    ]);
    let sequence = bookingCount + preAdviceCount + 1;
    while (true) {
        const value = `${prefix}${String(sequence).padStart(5, "0")}`;
        const [existingBooking, existingPreAdvice] = await Promise.all([
            Booking_js_1.default.exists({ bookingNumber: value }),
            PreAdvice_js_1.default.exists({ bookingNumber: value }),
        ]);
        if (!existingBooking && !existingPreAdvice)
            return value;
        sequence += 1;
    }
};
exports.buildBookingNumber = buildBookingNumber;
