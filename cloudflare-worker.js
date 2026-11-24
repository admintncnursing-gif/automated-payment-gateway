export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/pay/') ||
        url.pathname.startsWith('/checkout/') ||
        url.pathname.startsWith('/test')) {
      return env.ASSETS.fetch(new Request(new URL('/paywall.html', url.origin), request));
    }

    if (url.pathname === '/api/config') {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return Response.json({
          error: 'Configure SUPABASE_URL and SUPABASE_ANON_KEY in Cloudflare.'
        }, { status: 503 });
      }
      return Response.json({
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
        maintenance: { enabled: false, message: '' },
        deploymentMode: 'static-preview'
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({
        error: 'The ArchXpay Express API, Supabase admin portal, and Gmail IMAP watcher must run on a persistent Node host.'
      }, { status: 503 });
    }

    return env.ASSETS.fetch(request);
  }
};
