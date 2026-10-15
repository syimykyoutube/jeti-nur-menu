/* Vanilla browser code: no dependencies; UI messages come from src/lib/i18n.ts. */
(() => {
  'use strict';
  const TARGET_BYTES = 100 * 1024;

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('invalidImage')); };
      image.src = url;
    });
  }

  function webp(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (!blob || blob.type !== 'image/webp') reject(new Error('imageBrowserUnsupported'));
      else resolve(blob);
    }, 'image/webp', quality));
  }

  async function compress(file, longest) {
    const image = await readImage(file);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error('invalidImage');
    const ratio = Math.min(1, longest / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('imageBrowserUnsupported');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob = await webp(canvas, 0.75);
    // Very detailed photos may need a lower quality to stay near the 100 KB goal.
    for (const quality of [0.65, 0.55, 0.45]) {
      if (blob.size <= TARGET_BYTES) break;
      blob = await webp(canvas, quality);
    }
    // Guarantee the DoD's <=100 KB result even for unusually detailed source images.
    let longestSide = Math.max(canvas.width, canvas.height);
    while (blob.size > TARGET_BYTES && longestSide > 128) {
      longestSide = Math.floor(longestSide * 0.85);
      const smallerRatio = Math.min(1, longestSide / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * smallerRatio));
      canvas.height = Math.max(1, Math.round(height * smallerRatio));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await webp(canvas, 0.75);
    }
    if (blob.size > TARGET_BYTES) throw new Error('imageCompressionFailed');
    return { blob, width: canvas.width, height: canvas.height };
  }

  function upload(blob, widget, progress, status) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/admin/upload');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.responseType = 'json';
      xhr.timeout = 120000;
      xhr.upload.onprogress = event => {
        const percent = event.lengthComputable ? Math.min(95, Math.round(event.loaded / event.total * 95)) : 0;
        progress.value = percent;
        status.textContent = `${widget.dataset.uploading} ${percent}%`;
      };
      xhr.onload = () => {
        if (xhr.status === 201 && xhr.response && typeof xhr.response.key === 'string') resolve(xhr.response);
        else reject(Object.assign(new Error(xhr.response?.error || (xhr.status === 401 ? widget.dataset.sessionExpired : widget.dataset.requestFailed)), { publicMessage: true }));
      };
      xhr.onerror = xhr.ontimeout = () => reject(Object.assign(new Error(widget.dataset.requestFailed), { publicMessage: true }));
      const data = new FormData();
      data.set('cafe_id', widget.dataset.cafeId);
      data.set('kind', widget.dataset.kind);
      data.set('file', blob, 'image.webp');
      xhr.send(data);
    });
  }

  document.querySelectorAll('[data-image-upload]').forEach(widget => {
    const form = widget.closest('form');
    const input = widget.querySelector('[data-image-file]');
    const key = widget.querySelector('[data-image-key]');
    const preview = widget.querySelector('[data-image-preview]');
    const size = widget.querySelector('[data-image-size]');
    const status = widget.querySelector('[data-image-status]');
    const progress = widget.querySelector('progress');
    const remove = widget.querySelector('[data-image-remove]');
    let busy = false;
    form.addEventListener('submit', event => {
      if (busy) { event.preventDefault(); status.textContent = widget.dataset.imagePending; }
    });
    remove.addEventListener('click', () => {
      key.value = '';
      preview.removeAttribute('src');
      preview.hidden = true;
      remove.hidden = true;
      size.textContent = '';
      progress.hidden = true;
      status.textContent = widget.dataset.imageRemoved;
    });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file || busy) return;
      busy = true;
      input.disabled = remove.disabled = true;
      const submits = [...form.querySelectorAll('button:not([type=button]), input[type=submit]')];
      const disabled = submits.map(button => button.disabled);
      submits.forEach(button => button.disabled = true);
      form.setAttribute('aria-busy', 'true');
      status.classList.remove('error');
      status.textContent = widget.dataset.compressing;
      progress.hidden = false;
      progress.removeAttribute('value');
      size.textContent = '';
      try {
        // Yield once so the progress message paints before decoding a large photo.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const result = await compress(file, widget.dataset.kind === 'logo' ? 256 : 640);
        const kb = bytes => (bytes / 1024).toFixed(1) + ' ' + widget.dataset.kilobytes;
        size.textContent = `${kb(file.size)} → ${kb(result.blob.size)} · ${result.width} × ${result.height} px · WebP`;
        progress.value = 0;
        status.textContent = widget.dataset.uploading;
        const response = await upload(result.blob, widget, progress, status);
        key.value = response.key;
        preview.src = response.url;
        preview.hidden = remove.hidden = false;
        progress.value = 100;
        status.textContent = widget.dataset.imageReady;
      } catch (error) {
        progress.hidden = true;
        status.classList.add('error');
        status.textContent = widget.dataset[error.message] || (error.publicMessage ? error.message : widget.dataset.requestFailed);
      } finally {
        busy = false;
        input.disabled = remove.disabled = false;
        input.value = '';
        submits.forEach((button, index) => button.disabled = disabled[index]);
        form.removeAttribute('aria-busy');
      }
    });
  });
})();
