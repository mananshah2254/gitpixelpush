/* GitPixelPush deployment config. Fill in the client ID, see README.md.
   The client ID is public by design; the secret lives only in the Worker.
   The site and the exchange endpoint share one origin, so the URL is relative. */
window.GPP_CONFIG = {
  clientId: "YOUR_GITHUB_OAUTH_CLIENT_ID",
  exchangeUrl: "/exchange",
};
