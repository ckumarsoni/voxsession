require("dotenv").config();
module.exports = {
  PORT:           process.env.PORT           || 8080,
  JWT_SECRET:     process.env.JWT_SECRET     || "voxsession_secret_change_this",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123",
  NODE_ENV:       process.env.NODE_ENV       || "production",
};
