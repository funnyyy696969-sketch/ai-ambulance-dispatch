/**
 * CoTV-E verified dataset registry.
 *
 * EVERY entry below was verified against the cited official sources.
 * Access mechanics, annotation formats, label names, scales and license
 * status are reported exactly as verified; anything unverified is marked
 * `unknown` — never guessed.
 *
 * Facts verified Oct 2026 from the official pages below.
 */

export type AccessType = "public-clickthrough-license" | "account-gated";

export interface DatasetSource {
  id: string;
  title: string;
  url: string;
}

export interface DatasetFact {
  value: string;
  verified: boolean;
  /** where this fact comes from */
  note?: string;
}

export interface DatasetEntry {
  id: "idd" | "cityflow-v2";
  title: string;
  officialSite: string;
  access: AccessType;
  accessSteps: string[];
  license: DatasetFact;
  facts: DatasetFact[];
  annotationFormat: string;
  /** exact vehicle class names from the official label table (IDD) or
   * documented products (CityFlowV2) — never invented */
  vehicleClasses: string[];
  canAutomateDownload: boolean;
  sources: DatasetSource[];
}

export const IDD: DatasetEntry = {
  id: "idd",
  title: "India Driving Dataset (IDD) — IIIT Hyderabad",
  officialSite: "https://idd.insaan.iiit.ac.in/",
  access: "account-gated",
  accessSteps: [
    "1. Register an account at https://idd.insaan.iiit.ac.in/accounts/signup/",
    "2. Log in at https://idd.insaan.iiit.ac.in/accounts/login/",
    "3. Download from https://idd.insaan.iiit.ac.in/dataset/download/ (the download page redirects anonymous visitors to the login page — no public URL exists)",
    "4. The dataset license is presented inside the logged-in download flow; it is NOT visible without an account and could not be verified from public pages",
  ],
  license: {
    value: "unknown — terms are shown only inside the logged-in download flow; do not infer from the paper or mirrors",
    verified: false,
    note: "Verified that no public license text is reachable without login",
  },
  facts: [
    { value: "Segmentation release: 10,003 annotated images per the current official split table (6,993 train / 981 val / 2,029 test); the original paper reports 10,004 from 182 drive sequences", verified: true },
    { value: "Detection release: 46,588 images (31,569 train / 10,225 val / 4,794 test)", verified: true },
    { value: "Segmentation annotations: polygons in gtFine/{split}/{drive}/{id}_gtFine_polygons.json paired with leftImg8bit images; masks are generated via the team's createLabels.py", verified: true },
    { value: "Detection annotations: Pascal-VOC-like XML in Annotations/<capture>/<image>.xml with images in JPEGImages/ — NOT documented as COCO detection JSON", verified: true },
    { value: "Official utilities: AutoNUE public-code repo (createLabels.py, json2labelImg.py, json2instanceImg.py, evaluate_mIoU.py, evaluate_detection.py, anue_labels.py)", verified: true },
    { value: "Total download byte-sizes and total video hours are NOT published on the public pages (IDD-3D's 'over 5 hours' is a different dataset)", verified: true },
  ],
  annotationFormat:
    "Segmentation: polygon JSON under gtFine/. Detection: VOC-style XML under Annotations/. Both verified from github.com/AutoNUE/public-code",
  vehicleClasses: [
    "motorcycle", "bicycle", "autorickshaw", "car", "truck", "bus",
    "caravan", "trailer", "train", "vehicle fallback",
  ],
  canAutomateDownload: false,
  sources: [
    { id: "idd-home", title: "IDD homepage", url: "https://idd.insaan.iiit.ac.in/" },
    { id: "idd-details", title: "Official dataset details (split counts)", url: "https://idd.insaan.iiit.ac.in/dataset/details/" },
    { id: "idd-download", title: "Official download endpoint (login-gated)", url: "https://idd.insaan.iiit.ac.in/dataset/download/" },
    { id: "autonue-code", title: "AutoNUE public-code (formats, labels, utilities)", url: "https://github.com/AutoNUE/public-code" },
    { id: "anue-labels", title: "Official label table anue_labels.py", url: "https://github.com/AutoNUE/public-code/blob/master/helpers/anue_labels.py" },
    { id: "idd-paper", title: "IDD paper", url: "https://arxiv.org/abs/1811.10200" },
  ],
};

export const CITYFLOW_V2: DatasetEntry = {
  id: "cityflow-v2",
  title: "CityFlowV2 — AI City Challenge 2022 Track 1 (multi-camera vehicle tracking)",
  officialSite: "https://www.aicitychallenge.org/2022-data-and-evaluation/",
  access: "public-clickthrough-license",
  accessSteps: [
    "1. Open https://www.aicitychallenge.org/ai-city-challenge-dataset-access/ — 2022 Track 1 is listed as downloadable without a data-access request form or password",
    "2. Go to the 2022 Track 1 download page and click the download link — clicking constitutes acceptance of the data license agreement",
    "3. Read the bundled ReadMe.txt for the release layout (the ground-truth file schema is NOT reproduced on the official web page)",
    "4. Evaluation-server signup is separate and requires an institutional/non-commercial email sent to the organizers",
  ],
  license: {
    value: "click-through data license agreement (PDF linked on the download page: Dataset-License-AIC2022.pdf) — exact permitted use not certified; treat as research-restricted",
    verified: true,
    note: "Download link's click = acceptance is verified; full license text not extracted",
  },
  facts: [
    { value: "46 cameras, 16 intersections, 3.58 hours (215.03 min), ≥960p, mostly 10 FPS (not guaranteed uniform)", verified: true },
    { value: "6 scenarios: 3 train / 2 validation / 1 test", verified: true },
    { value: "313,931 bounding boxes across 880 distinct vehicle identities; only vehicles seen in ≥2 cameras are annotated", verified: true },
    { value: "Official ranking metric for MTMC tracking: IDF1 (IDP/IDR, detection precision/recall also reported; MOTA/MOTP/MT/FAR computed but not ranking)", verified: true },
    { value: "Submission line format: camera_id obj_id frame_id xmin ymin width height xworld yworld (space-delimited; frames start at 1; world coords unused in eval)", verified: true },
    { value: "Turning-movement ratios and traffic-demand matrices: VERIFIED ABSENT from all official documentation of this distribution", verified: true },
    { value: "The exact per-line schema of the RELEASED ground-truth files is not documented on the pages I could read — inspect the bundled ReadMe.txt after download; do not assume it matches the submission format", verified: true },
  ],
  annotationFormat:
    "Per-camera tracking text files (definite layout inside the archive; officially documented only for the submission format). Synchronize videos using the provided per-video start-time offsets.",
  vehicleClasses: [
    "vehicle identity tracks (no per-track class taxonomy is part of the 2022 Track 1 ground truth)",
  ],
  canAutomateDownload: true,
  sources: [
    { id: "aic-access", title: "AI City Challenge dataset access policy", url: "https://www.aicitychallenge.org/ai-city-challenge-dataset-access/" },
    { id: "aic-2022", title: "2022 Data and Evaluation (official facts)", url: "https://www.aicitychallenge.org/2022-data-and-evaluation/" },
    { id: "aic-2021", title: "2021 Data and Evaluation (separate counting track)", url: "https://www.aicitychallenge.org/2021-data-and-evaluation/" },
    { id: "aic-paper", title: "The 5th AI City Challenge paper", url: "https://arxiv.org/html/2104.12233v2" },
  ],
};

export const DATASETS: DatasetEntry[] = [IDD, CITYFLOW_V2];

/** Study city for all OSM work — set by the user, not invented. */
export const STUDY_CITY = "Chennai, India";
export const STUDY_CITY_CENTER = { lat: 13.0827, lng: 80.2707 };

/** Overpass query hints used for the Chennai context fetch. */
export const CITY_CONTEXT_QUERY = `
[out:json][timeout:60];
area["name"="Chennai"]["admin_level"="5"]->.a;
(
  node["amenity"="hospital"](area.a);
  node["highway"="traffic_signals"](area.a);
);
out count;`;
