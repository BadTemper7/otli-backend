"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePermissionModule = exports.normalizePermissions = exports.getAllAccessPermissions = exports.getEmptyPermissions = exports.fullPermission = exports.emptyPermission = exports.PERMISSION_ALIASES = exports.PERMISSION_MODULES = void 0;

exports.PERMISSION_MODULES = [
    "dashboard",
    "accounts",
    "operations",
    "yard",
    "billing",
    "reports",
    "settings",
];

exports.PERMISSION_ALIASES = {
    dashboard: ["dashboard"],
    accounts: ["accounts", "clients", "userManagement", "roleAccess", "clientVerification"],
    operations: ["operations", "preAdvice", "bookings", "gateAppointment", "gateIn"],
    yard: ["yard", "yardSetup", "inventory", "yardMap", "storageMonitoring"],
    billing: ["billing", "rateSetup", "paymentTypes", "paymentVerification", "gateOut", "blacklist", "chargeHold"],
    reports: ["reports", "auditTrail"],
    settings: ["settings"],
};

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

const getEmptyPermissions = () => exports.PERMISSION_MODULES.reduce((acc, moduleName) => {
    acc[moduleName] = (0, exports.emptyPermission)();
    return acc;
}, {});
exports.getEmptyPermissions = getEmptyPermissions;

const getAllAccessPermissions = () => exports.PERMISSION_MODULES.reduce((acc, moduleName) => {
    acc[moduleName] = (0, exports.fullPermission)();
    return acc;
}, {});
exports.getAllAccessPermissions = getAllAccessPermissions;

const resolvePermissionModule = (moduleName = "") => {
    const requested = String(moduleName || "").trim();
    return exports.PERMISSION_MODULES.find((groupName) => exports.PERMISSION_ALIASES[groupName].includes(requested)) || requested;
};
exports.resolvePermissionModule = resolvePermissionModule;

const normalizePermissions = (permissions = {}) => {
    const normalized = (0, exports.getEmptyPermissions)();

    exports.PERMISSION_MODULES.forEach((groupName) => {
        const aliases = exports.PERMISSION_ALIASES[groupName] || [groupName];
        normalized[groupName] = {
            view: aliases.some((moduleName) => Boolean(permissions?.[moduleName]?.view)),
            create: aliases.some((moduleName) => Boolean(permissions?.[moduleName]?.create)),
            edit: aliases.some((moduleName) => Boolean(permissions?.[moduleName]?.edit)),
            delete: aliases.some((moduleName) => Boolean(permissions?.[moduleName]?.delete)),
        };

        // Any write permission also requires the module to be visible.
        if (normalized[groupName].create || normalized[groupName].edit || normalized[groupName].delete) {
            normalized[groupName].view = true;
        }
    });

    return normalized;
};
exports.normalizePermissions = normalizePermissions;
