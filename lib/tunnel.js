async function startTunnel(port) {
  const provider = process.env.TUNNEL_PROVIDER || 'localtunnel';

  if (provider === 'none') {
    return { url: `http://localhost:${port}`, provider: 'none', close: () => {} };
  }

  if (provider === 'ngrok' && process.env.NGROK_AUTHTOKEN) {
    try {
      const ngrok = require('ngrok');
      const url = await ngrok.connect({
        addr: port,
        authtoken: process.env.NGROK_AUTHTOKEN
      });
      return { url, provider: 'ngrok', close: () => ngrok.disconnect(url) };
    } catch (err) {
      console.error('ngrok failed, falling back to localtunnel:', err.message);
    }
  }

  const localtunnel = require('localtunnel');
  const tunnel = await localtunnel({ port });

  tunnel.on('error', (err) => {
    console.error('Tunnel error:', err.message);
  });

  tunnel.on('close', () => {
    console.log('Tunnel closed. Restarting...');
    setTimeout(() => startTunnel(port), 3000);
  });

  return {
    url: tunnel.url,
    provider: 'localtunnel',
    close: () => tunnel.close()
  };
}

module.exports = { startTunnel };
