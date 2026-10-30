"use strict";

// Diagnostics for the existing upload + OTP flow. No extra packages or env vars.
// Timings start before Multer receives the multipart body.
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

const watchRegistrationRequest = (operation) => (req, res, next) => {
    const startedAt = nowMs();
    req.registrationTiming = { startedAt, stages: {} };

    res.once("finish", () => {
        const elapsedMs = nowMs() - startedAt;
        const stages = req.registrationTiming.stages;
        // Log slow requests and failures only. Do not log names, emails,
        // documents, OTPs, SMTP responses or credentials.
        if (elapsedMs >= 2000 || res.statusCode >= 400) {
            console.info(`[registration] ${operation} status=${res.statusCode} totalMs=${elapsedMs} stages=${JSON.stringify(stages)}`);
        }
    });
    res.once("close", () => {
        if (!res.writableEnded) {
            console.warn(`[registration] ${operation} browser/proxy disconnected after ${nowMs() - startedAt}ms`);
        }
    });
    next();
};

const markRegistrationUploadComplete = (req, _res, next) => {
    if (req.registrationTiming) {
        req.registrationTiming.stages.uploadMs = nowMs() - req.registrationTiming.startedAt;
    }
    next();
};

const timeRegistrationStage = async (req, stage, operation) => {
    const startedAt = nowMs();
    try {
        return await operation();
    } finally {
        if (req.registrationTiming) {
            req.registrationTiming.stages[stage] =
                (req.registrationTiming.stages[stage] || 0) + (nowMs() - startedAt);
        }
    }
};

module.exports = {
    watchRegistrationRequest,
    markRegistrationUploadComplete,
    timeRegistrationStage,
};
