const { invoke } = window.__TAURI__.core;
const status = document.getElementById('status');
document.querySelectorAll('button').forEach(button => {
  button.onclick = async () => {
    try { status.textContent = await invoke('act', { action: button.dataset.action }); }
    catch (error) { status.textContent = String(error); }
  };
});
window.__TAURI__.event.listen('status', event => { status.textContent = event.payload; });
invoke('act', { action: 'status' }).then(value => { status.textContent = value; });
