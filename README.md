# CropGuard web app

CropGuard is an experimental, on-device first-look tool for supported plant leaves. Its multi-crop model has **38 PlantVillage image classes across 14 crop types**. The set includes apple, blueberry, cherry, corn, grape, orange, peach, bell pepper, potato, raspberry, soybean, squash, strawberry, and tomato. This is a defined pilot library, not coverage of every vegetable, crop, or disease.

## Public site

The static app is hosted free with GitHub Pages. It runs ONNX inference in the visitor's browser. The leaf photo is processed on that device and is not uploaded. The model is public and is downloaded once per model version, then cached in browser storage. Scan history is stored in that browser only.

The deploy workflow publishes only `frontend/`; training code, checkpoints, datasets, field photos, and evaluation reports stay out of the public site. The model class order is saved beside the ONNX file in `frontend/model-classes.json` so prediction labels stay aligned with the exported model.

## Model training and evaluation

The 38-class model is trained from `data/raw/plantvillage_full/raw/color` with a deterministic, class-stratified 80/10/10 split. `src/training/train_multicrop.py` selects checkpoints on validation macro-F1; it evaluates the held-out PlantVillage test split only after selection.

Where the duplicate-grouped real-world potato dataset is present, field adaptation may be used to reduce the domain gap for potato while retaining the remaining PlantVillage classes:

```powershell
.\.venv\Scripts\python.exe src\training\adapt_multicrop_field.py `
  --field-data "C:\path\to\real_world_photos" `
  --epochs 4 --batch-size 16 --workers 2 --field-share 0.5
```

This script uses only field `train` rows and jointly selects a checkpoint on field validation and PlantVillage validation. The duplicate-grouped field `test` rows and PlantVillage test rows remain held out until final evaluation. Run the evaluation and browser export with:

```powershell
.\.venv\Scripts\python.exe src\evaluation\evaluate_multicrop_holdout.py `
  --field-data "C:\path\to\real_world_photos"
.\.venv\Scripts\python.exe src\deployment\export_multicrop_browser_model.py
```

The saved JSON reports include per-class metrics, confusion matrices, and how often field potatoes are assigned to an unsupported crop class. Do not treat performance on curated PlantVillage images as field accuracy. Field photos in this project are potato-only; other supported crop types still need real-world validation.

The current field-adapted checkpoint scored 92.88% accuracy and 0.9300 macro-F1 on the duplicate-grouped 2,319-image potato test split. The previous potato-only checkpoint scored 89.44% accuracy and 0.8966 macro-F1 on that same split. On 5,430 held-out PlantVillage images, the multi-crop model scored 99.58% accuracy and 0.9926 macro-F1. These are dataset results, not a promise of field accuracy; source field labels are unverified and potentially noisy.

## Update the website

The GitHub Pages workflow is configured to deploy `frontend/` on pushes to `main` when a file under `frontend/` changes. Export the checkpoint and class map together, review the held-out metrics, and publish both output files with the matching app files. The exported model is significantly smaller than the previous ResNet-50 model.

## Local preview

From the project root on Windows:

```powershell
python -m http.server 8000 --directory frontend
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The scanner runs in the browser; the local server only serves the app and model files.

## Responsible use

Model scores are raw outputs, not calibrated probabilities. The classifier always chooses a class from its 38 known labels and may be confidently wrong on unsupported plants, symptoms, or field conditions. Use it to guide inspection only; confirm disease and treatment decisions with a qualified local crop advisor.
