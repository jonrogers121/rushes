import type { User } from 'firebase/auth';
import type { FileMetadata } from '../types';

const DEFAULT_LOCAL_GOOGLE_SHEETS_SERVER_URL = 'http://localhost:3007';
const DEFAULT_PRODUCTION_GOOGLE_SHEETS_SERVER_URL = 'https://google-sheets.onrender.com/';
const DEFAULT_GOOGLE_SHEETS_SERVER_URL = import.meta.env.PROD
  ? DEFAULT_PRODUCTION_GOOGLE_SHEETS_SERVER_URL
  : DEFAULT_LOCAL_GOOGLE_SHEETS_SERVER_URL;
const DEFAULT_STORAGE_BUCKET = 'stillmotion-studio';
const MONGO_OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

type CloudUploadResponse = {
  video?: {
    _id?: string;
    videoUrl?: string;
    bucket?: string | null;
  };
  error?: string;
};

const getGoogleSheetsServerUrl = () => {
  const configuredUrl = import.meta.env.VITE_GOOGLE_SHEETS_SERVER_URL?.trim();
  const baseUrl = configuredUrl || DEFAULT_GOOGLE_SHEETS_SERVER_URL;
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
};

const getStorageBucket = () => {
  return import.meta.env.VITE_RUSHES_STORAGE_BUCKET?.trim() || DEFAULT_STORAGE_BUCKET;
};

const readErrorMessage = async (response: Response) => {
  try {
    const payload = await response.json();
    if (typeof payload?.error === 'string' && payload.error) {
      return payload.error;
    }
  } catch {
    // Fall through to text parsing.
  }

  try {
    const text = await response.text();
    if (text) {
      return text;
    }
  } catch {
    // Ignore response parsing failures.
  }

  return `Request failed with status ${response.status}`;
};

const buildAuthHeaders = async (user: User) => {
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
  };
};

const requestWithAuth = async (user: User, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  const authHeaders = await buildAuthHeaders(user);

  Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));

  return fetch(`${getGoogleSheetsServerUrl()}${path}`, {
    ...init,
    headers,
  });
};

export const isCloudBackedFile = (file: Pick<FileMetadata, 'id' | 'videoUrl'>) => {
  return Boolean(file.videoUrl && !file.videoUrl.startsWith('local:') && MONGO_OBJECT_ID_PATTERN.test(file.id));
};

export const uploadFileToCloud = async (user: User, file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('bucket', getStorageBucket());

  const response = await requestWithAuth(user, '/api/veo-video/upload', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = await response.json() as CloudUploadResponse;
  const cloudFileId = payload.video?._id;
  const videoUrl = payload.video?.videoUrl;

  if (!cloudFileId || !videoUrl) {
    throw new Error('Cloud upload did not return a usable file id and url.');
  }

  return {
    id: cloudFileId,
    videoUrl,
    bucket: payload.video?.bucket || getStorageBucket(),
  };
};

export const deleteCloudFile = async (user: User, cloudFileId: string) => {
  const response = await requestWithAuth(user, `/api/veo-video/${cloudFileId}`, {
    method: 'DELETE',
  });

  if (response.status === 404) {
    return;
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
};

export const downloadCloudArchiveBlob = async (user: User, ids: string[]) => {
  const response = await requestWithAuth(user, '/api/veo-video/download-archive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.blob();
};

const downloadDirectFileBlob = async (file: Pick<FileMetadata, 'id' | 'videoUrl'>) => {
  if (!file.videoUrl) {
    throw new Error('File does not have a download url.');
  }

  const response = await fetch(file.videoUrl);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.blob();
};

export const downloadFileBlob = async (user: User, file: Pick<FileMetadata, 'id' | 'videoUrl'>) => {
  if (!file.videoUrl) {
    throw new Error('File does not have a download url.');
  }

  if (isCloudBackedFile(file)) {
    const response = await requestWithAuth(user, `/api/veo-video/${file.id}/download`);
    if (response.ok) {
      return response.blob();
    }

    const proxyError = await readErrorMessage(response);
    if (response.status === 404) {
      try {
        return await downloadDirectFileBlob(file);
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`${proxyError} Direct URL fallback also failed: ${fallbackMessage}`);
      }
    }

    throw new Error(proxyError);
  }

  return downloadDirectFileBlob(file);
};
