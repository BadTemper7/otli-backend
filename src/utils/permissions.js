export const PERMISSION_MODULES = [
  "dashboard",
  "accounts",
  "clients",
  "userManagement",
  "roleAccess",
  "clientVerification",
  "preAdvice",
  "bookings",
  "gateAppointment",
  "gateIn",
  "yardSetup",
  "inventory",
  "yardMap",
  "storageMonitoring",
  "rateSetup",
  "billing",
  "paymentVerification",
  "gateOut",
  "blacklist",
  "chargeHold",
  "reports",
  "auditTrail",
  "settings",
]

export const emptyPermission = () => ({
  view: false,
  create: false,
  edit: false,
  delete: false,
})

export const fullPermission = () => ({
  view: true,
  create: true,
  edit: true,
  delete: true,
})

export const getEmptyPermissions = () => {
  return PERMISSION_MODULES.reduce((acc, moduleName) => {
    acc[moduleName] = emptyPermission()
    return acc
  }, {})
}

export const getAllAccessPermissions = () => {
  return PERMISSION_MODULES.reduce((acc, moduleName) => {
    acc[moduleName] = fullPermission()
    return acc
  }, {})
}

export const normalizePermissions = (permissions = {}) => {
  const normalized = getEmptyPermissions()

  PERMISSION_MODULES.forEach((moduleName) => {
    const incoming = permissions?.[moduleName] || {}
    normalized[moduleName] = {
      view: Boolean(incoming.view),
      create: Boolean(incoming.create),
      edit: Boolean(incoming.edit),
      delete: Boolean(incoming.delete),
    }
  })

  return normalized
}
