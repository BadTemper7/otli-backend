"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePermissions = exports.getAllAccessPermissions = exports.getEmptyPermissions = exports.fullPermission = exports.emptyPermission = exports.PERMISSION_MODULES = void 0;
exports.PERMISSION_MODULES = [
    "dashboard",
    "userManagement",
    "clientVerification",
    "preAdvice",
    "bookings",
    "gateAppointment",
    "gateIn",
    "yardSetup",
    "inventory",
    "storageMonitoring",
    "rateSetup",
    "paymentTypes",
    "billing",
    "paymentVerification",
    "gateOut",
    "blacklist",
    "chargeHold",
    "reports",
    "auditTrail",
    "settings",
];
const emptyPermission = () => ({
    view: false,
    create: false,
    edit: false,
    delete: false,
});
exports.emptyPermission = emptyPermission;
const fullPermission = () => ({
    view: true,
    create: true,
    edit: true,
    delete: true,
});
exports.fullPermission = fullPermission;
const getEmptyPermissions = () => {
    return exports.PERMISSION_MODULES.reduce((acc, moduleName) => {
        acc[moduleName] = (0, exports.emptyPermission)();
        return acc;
    }, {});
};
exports.getEmptyPermissions = getEmptyPermissions;
const getAllAccessPermissions = () => {
    return exports.PERMISSION_MODULES.reduce((acc, moduleName) => {
        acc[moduleName] = (0, exports.fullPermission)();
        return acc;
    }, {});
};
exports.getAllAccessPermissions = getAllAccessPermissions;
const normalizePermissions = (permissions = {}) => {
    const normalized = (0, exports.getEmptyPermissions)();
    exports.PERMISSION_MODULES.forEach((moduleName) => {
        const incoming = permissions?.[moduleName] || {};
        normalized[moduleName] = {
            view: Boolean(incoming.view),
            create: Boolean(incoming.create),
            edit: Boolean(incoming.edit),
            delete: Boolean(incoming.delete),
        };
    });
    return normalized;
};
exports.normalizePermissions = normalizePermissions;
