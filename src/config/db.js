import mongoose from "mongoose"

export const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from the Hostinger environment variables.")
  }

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      maxPoolSize: 10,
    })

    console.log(`MongoDB connected: ${conn.connection.host}`)
    return conn
  } catch (error) {
    throw new Error(
      `MongoDB connection failed: ${error.message}. Check the Atlas IP access list, database user, and MONGODB_URI.`,
    )
  }
}
