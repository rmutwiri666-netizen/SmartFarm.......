// Render creates this URL for the smartfarm-api service in render.yaml.
// If Render assigns a different service URL, replace it with that public URL.
const localHostnames = new Set(['localhost', '127.0.0.1']);
window.SMARTFARM_API_BASE_URL = localHostnames.has(window.location.hostname)
	? ''
	: 'https://smartfarm-api.onrender.com';
