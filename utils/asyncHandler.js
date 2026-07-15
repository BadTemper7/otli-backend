"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const asyncHandler = (handler) => {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
};
exports.default = asyncHandler;
