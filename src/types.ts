export type ReviewStatus = 'unreviewed' | 'promoted' | 'rejected';

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  previewUrl?: string;
  videoUrl?: string;
  uploadedAt: Date;
  sortIndex?: number;
  aiAnalysis?: {
    summary: string;
    tags: string[];
  };
  customTags?: string[];
  reviewStatus?: ReviewStatus;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  videoFiles: FileMetadata[];
  sourceFiles: FileMetadata[];
  ownerId: string;
}
