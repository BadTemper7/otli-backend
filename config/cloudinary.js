"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteFromCloudinary = exports.uploadBufferToCloudinary = void 0;
const stream_1 = require("stream");
const cloudinary_1 = require("cloudinary");
cloudinary_1.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});
const uploadBufferToCloudinary = ({ file, folder, publicIdPrefix }) => {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        throw new Error("Cloudinary credentials are missing in .env");
    }
    const safeFolder = folder || process.env.CLOUDINARY_FOLDER || "otli-documents";
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary_1.v2.uploader.upload_stream({
            folder: safeFolder,
            public_id: publicIdPrefix,
            resource_type: "auto",
        }, (error, result) => {
            if (error)
                return reject(error);
            resolve(result);
        });
        stream_1.Readable.from(file.buffer).pipe(uploadStream);
    });
};
exports.uploadBufferToCloudinary = uploadBufferToCloudinary;
const deleteFromCloudinary = async (publicId, resourceType = "image") => {
    if (!publicId)
        return null;
    return cloudinary_1.v2.uploader.destroy(publicId, { resource_type: resourceType });
};
exports.deleteFromCloudinary = deleteFromCloudinary;
