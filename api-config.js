/*
 * Set this to the public Render URL after creating the service.
 * Example: https://sapc-ai-reviewer-api.onrender.com
 */
const isLocalPreview = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  && window.location.port !== "3000";

window.SAPC_API_BASE_URL = isLocalPreview
  ? "http://localhost:3000"
  : "";

// Cloudinary browser uploads use an unsigned preset. Never put an API secret here.
window.SAPC_CLOUDINARY_CONFIG = {
  cloudName: "x3fejaey",
  uploadPreset: "ai_driven_academic_reviewer_chat"
};
