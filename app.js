const MAX_FILE_SIZE = 12 * 1024 * 1024;
const STORAGE_KEY = 'cropguard.field-history.v1';
const MODEL_URL = new URL('model.onnx', document.baseURI).href;
const CLASS_MAP_URL = new URL('model-classes.json?v=3', document.baseURI).href;
const MODEL_CACHE_DB = 'cropguard-browser-models';
const IMAGE_SIZE = 224;
const CHANNEL_MEAN = [0.485, 0.456, 0.406];
const CHANNEL_STD = [0.229, 0.224, 0.225];
const modelMetadataPromise = fetch(CLASS_MAP_URL, { cache: 'force-cache' }).then(async (response) => {
  if (!response.ok) throw new Error('Crop coverage information could not be loaded. Refresh and try again.');
  const metadata = await response.json();
  if (!Array.isArray(metadata.class_names) || metadata.class_names.length !== 38) {
    throw new Error('The multi-crop model information is incomplete. Refresh and try again.');
  }
  return metadata;
});

const fileInput = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const dropContent = document.querySelector('#drop-content');
const previewWrap = document.querySelector('#preview-wrap');
const imagePreview = document.querySelector('#image-preview');
const analyzeButton = document.querySelector('#analyze-button');
const uploadError = document.querySelector('#upload-error');
const resultEmpty = document.querySelector('#result-empty');
const resultContent = document.querySelector('#result-content');
const resultLoading = document.querySelector('#result-loading');
const statusPill = document.querySelector('#api-status');
const statusText = document.querySelector('#api-status-text');
let selectedFile = null;
let previewUrl = null;
let modelSessionPromise = null;

function prettyBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showError(message) {
  uploadError.textContent = message;
  uploadError.classList.remove('hidden');
}

function clearError() {
  uploadError.textContent = '';
  uploadError.classList.add('hidden');
}

function clearSelectedFile() {
  selectedFile = null;
  fileInput.value = '';
  analyzeButton.disabled = true;
  previewWrap.classList.add('hidden');
  dropContent.classList.remove('hidden');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function selectFile(file) {
  clearError();
  if (!file) return;
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];
  if (!allowed.includes(file.type)) {
    clearSelectedFile();
    showError('Choose a JPG, PNG, WEBP, or BMP image.');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    clearSelectedFile();
    showError('This image is larger than 12 MB. Choose a smaller photo.');
    return;
  }

  selectedFile = file;
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
  document.querySelector('#file-name').textContent = file.name;
  document.querySelector('#file-size').textContent = prettyBytes(file.size);
  dropContent.classList.add('hidden');
  previewWrap.classList.remove('hidden');
  analyzeButton.disabled = false;
}

document.querySelector('#browse-button').addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', (event) => {
  if (event.target.closest('#remove-image') || event.target.closest('#browse-button')) return;
  fileInput.click();
});

dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => selectFile(fileInput.files?.[0]));
document.querySelector('#remove-image').addEventListener('click', (event) => {
  event.stopPropagation();
  clearSelectedFile();
  clearError();
});

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', (event) => selectFile(event.dataTransfer?.files?.[0]));

function setApiStatus(state, text) {
  statusPill.classList.remove('online', 'offline');
  if (state === 'online') statusPill.classList.add('online');
  if (state === 'offline') statusPill.classList.add('offline');
  statusText.textContent = text;
}

function openModelCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODEL_CACHE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('models');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open browser model cache.'));
  });
}

async function readCachedModel(cacheKey) {
  const database = await openModelCache();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('models', 'readonly');
    const request = transaction.objectStore('models').get(cacheKey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read the cached model.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
  });
}

async function cacheModel(bytes, cacheKey) {
  const database = await openModelCache();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('models', 'readwrite');
    transaction.objectStore('models').put(bytes, cacheKey);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

async function fetchModelBytes(metadata) {
  const cacheKey = `cropguard-${metadata.version}`;
  try {
    const cached = await readCachedModel(cacheKey);
    if (cached instanceof ArrayBuffer && cached.byteLength > 0) return new Uint8Array(cached);
  } catch {
    // Browser storage can be unavailable or full; inference can still use a fresh download.
  }

  const sizeLabel = `${Math.round(metadata.model_bytes / 1024 / 1024)} MB`;
  setApiStatus('', `Downloading AI model · ${sizeLabel} once`);
  const response = await fetch(MODEL_URL, { cache: 'force-cache' });
  if (!response.ok) throw new Error('Could not download the AI model. Check your connection and retry.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 1_000_000) throw new Error('The AI model download was incomplete. Please retry.');
  try {
    await cacheModel(bytes, cacheKey);
  } catch {
    // A storage quota failure should not prevent this scan.
  }
  return new Uint8Array(bytes);
}

async function getModelSession() {
  if (!modelSessionPromise) {
    modelSessionPromise = (async () => {
      const metadata = await modelMetadataPromise;
      if (!window.ort?.InferenceSession) {
        throw new Error('The browser AI runtime did not load. Refresh the page and try again.');
      }
      window.ort.env.wasm.numThreads = 1;
      window.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
      const bytes = await fetchModelBytes(metadata);
      setApiStatus('', 'Preparing the AI model on this device…');
      return window.ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })().catch((error) => {
      modelSessionPromise = null;
      throw error;
    });
  }
  return modelSessionPromise;
}

function imageToTensor(image) {
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const pixels = context.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
  const planeSize = IMAGE_SIZE * IMAGE_SIZE;
  const values = new Float32Array(3 * planeSize);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const unitValue = pixels[pixel * 4 + channel] / 255;
      values[channel * planeSize + pixel] = (unitValue - CHANNEL_MEAN[channel]) / CHANNEL_STD[channel];
    }
  }
  return new window.ort.Tensor('float32', values, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
}

function probabilitiesFromLogits(logits) {
  const values = Array.from(logits);
  const maximum = Math.max(...values);
  const exponents = values.map((value) => Math.exp(value - maximum));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  return exponents.map((value) => value / total);
}

async function predictOnDevice(image) {
  const session = await getModelSession();
  const input = imageToTensor(image);
  const outputs = await session.run({ input });
  const scores = probabilitiesFromLogits(outputs.logits.data);
  const metadata = await modelMetadataPromise;
  if (scores.length !== metadata.class_names.length) {
    throw new Error('The AI model and crop labels do not match. Refresh the page and retry.');
  }
  const ranked = scores.map((probability, index) => ({
    class_name: metadata.class_names[index],
    display_name: displayClass(metadata.class_names[index]),
    probability,
  })).sort((left, right) => right.probability - left.probability);
  const best = ranked[0];
  return {
    predicted_class: best.class_name,
    display_name: best.display_name,
    confidence: best.probability,
    probabilities: ranked.slice(0, 5),
  };
}

function titleCase(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\s+/g, ' ').trim();
}

function displayClass(className) {
  const [rawCrop, ...rawCondition] = className.split('___');
  const cropLabel = titleCase(rawCrop.replaceAll('_', ' '));
  const cropAliases = {
    'Corn (Maize)': 'Corn',
    'Cherry (Including Sour)': 'Cherry',
    'Pepper, Bell': 'Bell pepper',
  };
  const crop = cropAliases[cropLabel] || cropLabel;
  const condition = rawCondition.join(' ').replaceAll('_', ' ')
    .replace(/Haunglongbing/gi, 'Huanglongbing').replace(/\s+/g, ' ').trim();
  const disease = /healthy/i.test(condition) ? 'Healthy' : titleCase(condition);
  return `${crop} · ${disease}`;
}

function isHealthyClass(className) {
  return /(^|___)healthy$/i.test(className);
}

function renderCropCoverage(classNames) {
  const container = document.querySelector('#crop-coverage');
  const crops = [...new Set(classNames.map((name) => displayClass(name).split(' · ')[0]))].sort();
  document.querySelector('#crop-count').textContent = `${crops.length} crop types · ${classNames.length} conditions`;
  container.replaceChildren(...crops.map((crop) => {
    const chip = document.createElement('span');
    chip.className = 'crop-chip';
    chip.textContent = crop;
    return chip;
  }));
}

modelMetadataPromise.then((metadata) => renderCropCoverage(metadata.class_names)).catch(() => {
  document.querySelector('#crop-count').textContent = 'Crop coverage is unavailable offline';
});

function appendProbabilityRow(item, index) {
  const row = document.createElement('div');
  row.className = 'probability-row';
  const name = document.createElement('span');
  name.textContent = item.display_name || displayClass(item.class_name) || 'Other';
  const track = document.createElement('span');
  track.className = 'bar-track';
  const fill = document.createElement('span');
  fill.className = 'bar-fill';
  const score = Number(item.probability);
  fill.style.width = `${Math.max(0, Math.min(100, score * 100))}%`;
  if (index > 0) fill.style.background = '#65527e';
  track.append(fill);
  const value = document.createElement('span');
  value.className = 'bar-value';
  value.textContent = `${Math.round(score * 100)}%`;
  row.append(name, track, value);
  return row;
}

function renderResult(data) {
  const label = data.display_name || displayClass(data.predicted_class) || 'Result unavailable';
  const confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0));
  document.querySelector('#prediction-title').textContent = label;
  document.querySelector('#prediction-description').textContent = `Best visual match in the ${label.split(' · ')[0]} classes. Model scores can be uncertain.`;
  document.querySelector('#score-value').textContent = `${Math.round(confidence * 100)}%`;
  document.querySelector('#score-ring').style.background = `conic-gradient(#a98aff 0 ${confidence * 100}%, #594a73 ${confidence * 100}% 100%)`;
  document.querySelector('#advice-copy').textContent = isHealthyClass(data.predicted_class)
    ? 'No listed disease class matched strongly. This does not guarantee the plant is disease-free; keep monitoring and check the whole plant.'
    : 'Inspect several leaves for matching signs. Confirm the crop and issue with a qualified local advisor before treatment.';
  document.querySelector('#result-time').textContent = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  const probabilities = document.querySelector('#probability-list');
  probabilities.replaceChildren(...(data.probabilities || []).map(appendProbabilityRow));
  resultEmpty.classList.add('hidden');
  resultLoading.classList.add('hidden');
  resultContent.classList.remove('hidden');
  addHistory({ label, predictedClass: data.predicted_class, confidence, date: new Date().toISOString(), fileName: selectedFile?.name || 'Leaf photo' });
}

analyzeButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  clearError();
  resultEmpty.classList.add('hidden');
  resultContent.classList.add('hidden');
  resultLoading.classList.remove('hidden');
  analyzeButton.disabled = true;
  analyzeButton.querySelector('span').textContent = 'Analyzing…';
  setApiStatus('', 'Analyzing image');

  try {
    const result = await predictOnDevice(imagePreview);
    renderResult(result);
    setApiStatus('online', 'On-device AI ready');
  } catch (error) {
    resultLoading.classList.add('hidden');
    resultEmpty.classList.remove('hidden');
    showError(error.message || 'Could not analyze this photo on your device.');
    setApiStatus('offline', 'AI model unavailable');
  } finally {
    analyzeButton.disabled = !selectedFile;
    analyzeButton.querySelector('span').textContent = 'Analyze leaf';
  }
});

document.querySelector('#scan-another').addEventListener('click', () => {
  clearSelectedFile();
  clearError();
  resultContent.classList.add('hidden');
  resultLoading.classList.add('hidden');
  resultEmpty.classList.remove('hidden');
  document.querySelector('#scan').scrollIntoView({ behavior: 'smooth' });
});

function readHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function addHistory(entry) {
  const items = [entry, ...readHistory()].slice(0, 8);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  renderHistory(items);
}

function renderHistory(items = readHistory()) {
  const panel = document.querySelector('#history-panel');
  const clearButton = document.querySelector('#clear-history');
  if (!items.length) {
    clearButton.classList.add('hidden');
    panel.innerHTML = '<div class="history-empty"><span class="history-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h10"/><circle cx="18" cy="17.5" r="2.5"/></svg></span><div><strong>No leaf checks yet</strong><span>Your recent scans appear here on this device.</span></div><a href="#scan" class="history-start">Make your first scan <span>→</span></a></div>';
    return;
  }
  clearButton.classList.remove('hidden');
  const list = document.createElement('div');
  list.className = 'history-list';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const icon = document.createElement('span');
    icon.className = 'history-empty-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20c-5-2.7-7-6.8-5.1-12.5C12.5 6.8 16.7 8.8 19.5 14c-1.4 3.9-3.8 6-7.5 6Z"/><path d="M8.5 9.5c2.9 2.6 5.2 5.4 6.9 8.8"/></svg>';
    const info = document.createElement('div');
    info.className = 'history-info';
    const title = document.createElement('strong');
    title.textContent = item.fileName || 'Leaf photo';
    const date = document.createElement('span');
    date.textContent = new Date(item.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    info.append(title, date);
    const badge = document.createElement('span');
    badge.className = `history-result${isHealthyClass(item.predictedClass) ? ' healthy' : ''}`;
    badge.textContent = item.label || 'Leaf check';
    row.append(icon, info, badge);
    list.append(row);
  }
  panel.replaceChildren(list);
}

document.querySelector('#clear-history').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  renderHistory([]);
});

const navLinks = [...document.querySelectorAll('[data-nav]')];
const navSections = navLinks.map((link) => document.getElementById(link.dataset.nav)).filter(Boolean);
const sectionNames = { overview: 'Overview', scan: 'Leaf scan', history: 'Field history', 'how-it-works': 'How it works' };
const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  const name = visible.target.id;
  navLinks.forEach((link) => link.classList.toggle('active', link.dataset.nav === name));
  document.querySelector('#breadcrumb-current').textContent = sectionNames[name] || 'Overview';
}, { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.15, 0.4] });
navSections.forEach((section) => observer.observe(section));

renderHistory();
setApiStatus('', 'AI runs on this device');
