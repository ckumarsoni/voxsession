require("dotenv").config();
module.exports = {
  PORT:           process.env.PORT           || 3000,
  JWT_SECRET:     process.env.JWT_SECRET     || "voxsession_v4_secret_change_this",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123",
  NODE_ENV:       process.env.NODE_ENV       || "production",
};
