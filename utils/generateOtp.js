"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareOtp = exports.hashOtp = exports.generateOtp = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));
exports.generateOtp = generateOtp;
const hashOtp = async (otp) => {
    const salt = await bcryptjs_1.default.genSalt(10);
    return bcryptjs_1.default.hash(String(otp), salt);
};
exports.hashOtp = hashOtp;
const compareOtp = async (otp, otpHash) => bcryptjs_1.default.compare(String(otp), otpHash);
exports.compareOtp = compareOtp;
