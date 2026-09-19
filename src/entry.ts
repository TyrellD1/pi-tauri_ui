async function start() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('dev')) {
    const { installPreview } = await import('./dev-preview');
    installPreview();
  }
  await import('./main');
}
void start();
