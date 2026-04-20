/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { 
  Film, 
  FileVideo, 
  FileCode, 
  Plus, 
  Trash2, 
  Download, 
  Clock, 
  LayoutGrid, 
  List as ListIcon, 
  Upload, 
  ChevronRight, 
  FolderOpen,
  X,
  Play,
  LogIn,
  LogOut,
  User as UserIcon,
  ShieldCheck,
  FileText,
  Image as ImageIcon,
  Music,
  Archive,
  File as GenericFile,
  CheckCircle2,
  Circle,
  PackageCheck,
  Sparkles,
  Tag
} from 'lucide-react';
import { useDropzone, DropzoneOptions } from 'react-dropzone';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { GoogleGenAI, Type } from "@google/genai";
import { cn, formatFileSize } from './lib/utils';
import { Project, FileMetadata } from './types';
import { auth, db } from './lib/firebase';
import { deleteCloudFile, downloadFileBlob, isCloudBackedFile, uploadFileToCloud } from './lib/cloudStorage';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  User
} from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  doc, 
  serverTimestamp, 
  orderBy,
  setDoc,
  getDocs,
  Timestamp
} from 'firebase/firestore';
import { get, del } from 'idb-keyval';

// --- Logic Helpers ---

const getFileIcon = (mimeType: string, className: string = "w-4 h-4 text-zinc-700 group-hover:text-amber-500 transition-colors") => {
  if (!mimeType) return <GenericFile className={className} />;
  if (mimeType.startsWith('image/')) return <ImageIcon className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType.includes('pdf')) return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return <Archive className={className} />;
  return <GenericFile className={className} />;
};

const generateVideoThumbnail = (file: File): Promise<string> => {
  return new Promise((resolve) => {
    let handled = false;
    const url = URL.createObjectURL(file);

    const timeout = setTimeout(() => {
      if (!handled) {
        handled = true;
        URL.revokeObjectURL(url);
        resolve('');
      }
    }, 5000);

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    
    video.onloadeddata = () => {
      if (handled) return;
      // Seek to 1s or 25% of the video length
      video.currentTime = Math.min(1, video.duration * 0.25) || 0.1;
    };
    
    video.onseeked = () => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      
      const canvas = document.createElement('canvas');
      const MAX_WIDTH = 320;
      let width = video.videoWidth;
      let height = video.videoHeight;
      
      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width);
        width = MAX_WIDTH;
      }
      
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(video, 0, 0, width, height);
      
      // Compress highly to fit in Firestore 1MB string limits easily
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      URL.revokeObjectURL(url);
      resolve(dataUrl);
    };
    
    video.onerror = () => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      resolve(''); // Fallback to no preview on error
    };
  });
};

const generateImageThumbnail = (file: File): Promise<string> => {
  return new Promise((resolve) => {
    let handled = false;
    const url = URL.createObjectURL(file);

    const timeout = setTimeout(() => {
      if (!handled) {
        handled = true;
        URL.revokeObjectURL(url);
        resolve('');
      }
    }, 5000);

    const img = new Image();
    img.src = url;
    
    img.onload = () => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      
      const canvas = document.createElement('canvas');
      const MAX_WIDTH = 120; // Smaller size for asset icons
      let width = img.width;
      let height = img.height;
      
      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width);
        width = MAX_WIDTH;
      }
      
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0, width, height);
      
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      URL.revokeObjectURL(url);
      resolve(dataUrl);
    };
    
    img.onerror = () => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      resolve('');
    };
  });
};

const handleFirestoreError = (error: any, operation: string, path: string | null = null) => {
  if (error.code === 'permission-denied') {
    const errorInfo = {
      error: error.message,
      operationType: operation,
      path: path,
      authInfo: {
        userId: auth.currentUser?.uid || 'anonymous',
        email: auth.currentUser?.email || 'N/A',
        emailVerified: auth.currentUser?.emailVerified || false,
        isAnonymous: auth.currentUser?.isAnonymous || true,
        providerInfo: auth.currentUser?.providerData.map(p => ({
          providerId: p.providerId,
          displayName: p.displayName || '',
          email: p.email || '',
        })) || []
      }
    };
    console.error('Firestore Permission Denied:', JSON.stringify(errorInfo, null, 2));
    throw new Error(JSON.stringify(errorInfo));
  }
  throw error;
};

// --- Components ---

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
};

const Button = ({ className, variant = 'primary', size = 'md', children, ...props }: ButtonProps) => {
  const variants = {
    primary: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20',
    secondary: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700',
    ghost: 'hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100',
    danger: 'hover:bg-red-900/30 text-red-400 hover:text-red-300 border border-transparent hover:border-red-900/50',
  };
  
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  };

  return (
    <button 
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};

interface FileDropzoneProps {
  onFilesAdded: (files: File[]) => void;
  label: string;
  accept?: Record<string, string[]>;
  icon: React.ReactNode;
}

const FileDropzone = ({ onFilesAdded, label, accept, icon }: FileDropzoneProps) => {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    onFilesAdded(acceptedFiles);
  }, [onFilesAdded]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept
  } as any);

  return (
    <div 
      {...getRootProps()} 
      className={cn(
        "group relative flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl transition-all cursor-pointer",
        isDragActive ? "border-emerald-500 bg-emerald-900/10" : "border-zinc-800 hover:border-zinc-700 bg-zinc-900/50 hover:bg-zinc-900"
      )}
    >
      <input {...getInputProps()} />
      <div className={cn(
        "mb-4 p-3 rounded-full bg-zinc-800 group-hover:bg-zinc-700 transition-colors",
        isDragActive && "bg-emerald-900 text-emerald-400"
      )}>
        {icon}
      </div>
      <p className="text-sm font-medium text-zinc-300">{label}</p>
      <p className="mt-1 text-xs text-zinc-500">Drag & drop or click to upload</p>
    </div>
  );
};

// --- Main App ---

const VideoModal = ({ playingVideo, setPlayingVideo }: { playingVideo: FileMetadata, setPlayingVideo: (v: FileMetadata | null) => void }) => {
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<boolean>(false);

  useEffect(() => {
    if (playingVideo.videoUrl?.startsWith('local:')) {
      const fileId = playingVideo.videoUrl.split(':')[1];
      get(`file_${fileId}`).then(file => {
        if (file) {
          setLocalUrl(URL.createObjectURL(file as Blob));
        } else {
          setErrorStatus(true);
        }
      }).catch(() => setErrorStatus(true));
    } else {
      setLocalUrl(playingVideo.videoUrl || null);
    }

    return () => {
      // Cleanup locally created object URLs
      if (localUrl && localUrl.startsWith('blob:')) {
        URL.revokeObjectURL(localUrl);
      }
    };
  }, [playingVideo]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-zinc-950/90 backdrop-blur-xl"
      onClick={() => setPlayingVideo(null)}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-6xl bg-black border border-zinc-900 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-full relative"
      >
        <div className="absolute top-0 inset-x-0 h-16 bg-gradient-to-b from-black/80 to-transparent z-10 pointer-events-none" />
        <div className="absolute top-4 right-4 z-20">
          <button
            onClick={() => setPlayingVideo(null)}
            className="p-2 bg-black/50 hover:bg-white/10 rounded-full text-white backdrop-blur-md transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="flex-1 bg-black aspect-video flex items-center justify-center relative">
          {localUrl ? (
            <video 
              src={localUrl} 
              controls 
              autoPlay 
              className="w-full h-full"
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 text-zinc-500">
              <FileVideo className="w-16 h-16 opacity-50" />
              <p className="font-mono text-sm uppercase tracking-widest">Video Stream Unavailable</p>
              <p className="text-xs uppercase max-w-xs text-center opacity-50">
                {errorStatus ? 'This video is stored locally on another device and has not synced.' : 'This asset was ingested without cloud blob storage active. Re-upload to stream.'}
              </p>
            </div>
          )}
        </div>
        
        <div className="bg-[#0a0a0a] border-t border-zinc-900 p-6 flex items-center justify-between z-10 shrink-0">
          <div>
            <h3 className="text-white font-bold tracking-widest uppercase">{playingVideo.name}</h3>
            <div className="flex items-center gap-4 mt-1 opacity-50">
              <span className="text-[10px] font-mono text-emerald-400 capitalize tabular-nums tracking-widest">{formatFileSize(playingVideo.size)}</span>
            </div>
          </div>
          {localUrl && (
            <Button variant="secondary" size="sm" onClick={() => window.open(localUrl)}>
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeVideoFiles, setActiveVideoFiles] = useState<FileMetadata[]>([]);
  const [activeSourceFiles, setActiveSourceFiles] = useState<FileMetadata[]>([]);
  
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<FileMetadata | null>(null);
  const [uploadingFiles, setUploadingFiles] = useState<{file: File, type: 'video' | 'source'}[]>([]);
  const [activeTab, setActiveTab] = useState<'rushes' | 'assets'>('rushes');
  const [assetPage, setAssetPage] = useState(1);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // 1. Auth Listener
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
  }, []);

  // 2. Projects Listener
  useEffect(() => {
    if (!user) {
      setProjects([]);
      return;
    }

    const q = query(
      collection(db, 'projects'),
      where('ownerId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    return onSnapshot(q, (snapshot) => {
      const pData: Project[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt ? (doc.data().createdAt as Timestamp).toDate() : new Date(),
        videoFiles: [], // Loaded separately
        sourceFiles: [] // Loaded separately
      } as Project));
      setProjects(pData);
    }, (error) => handleFirestoreError(error, 'list', 'projects'));
  }, [user]);

  // 3. Active Project Files Listener
  useEffect(() => {
    setSelectedFiles(new Set()); // Reset on project switch
    if (!user || !activeProjectId) {
      setActiveVideoFiles([]);
      setActiveSourceFiles([]);
      return;
    }

    const videoQ = query(collection(db, `projects/${activeProjectId}/videoFiles`), orderBy('uploadedAt', 'desc'));
    const sourceQ = query(collection(db, `projects/${activeProjectId}/sourceFiles`), orderBy('uploadedAt', 'desc'));

    const unsubVideo = onSnapshot(videoQ, (snapshot) => {
      setActiveVideoFiles(snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        uploadedAt: doc.data().uploadedAt ? (doc.data().uploadedAt as Timestamp).toDate() : new Date()
      } as FileMetadata)));
    });

    const unsubSource = onSnapshot(sourceQ, (snapshot) => {
      setActiveSourceFiles(snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        uploadedAt: doc.data().uploadedAt ? (doc.data().uploadedAt as Timestamp).toDate() : new Date()
      } as FileMetadata)));
    });

    return () => {
      unsubVideo();
      unsubSource();
    };
  }, [user, activeProjectId]);

  const activeProject = useMemo(() => 
    projects.find(p => p.id === activeProjectId) || null,
  [projects, activeProjectId]);

  const ITEMS_PER_PAGE = 20;
  const totalAssetPages = Math.max(1, Math.ceil(activeSourceFiles.length / ITEMS_PER_PAGE));
  const currentAssetPage = Math.min(assetPage, totalAssetPages);
  const paginatedSourceFiles = activeSourceFiles.slice((currentAssetPage - 1) * ITEMS_PER_PAGE, currentAssetPage * ITEMS_PER_PAGE);

  const toggleSelectStatus = useCallback((fileId: string) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  }, []);

  const [isDownloading, setIsDownloading] = useState(false);

  const removeStoredFile = useCallback(async ({
    projectId,
    file,
    type,
  }: {
    projectId: string;
    file: FileMetadata;
    type: 'video' | 'source';
  }) => {
    if (file.videoUrl?.startsWith('local:')) {
      const localId = file.videoUrl.split(':')[1];
      if (localId) {
        await del(`file_${localId}`);
      }
    } else if (user && isCloudBackedFile(file)) {
      await deleteCloudFile(user, file.id);
    }

    await deleteDoc(doc(db, `projects/${projectId}/${type}Files`, file.id));
  }, [user]);
  
  const handleBulkDownload = async () => {
    if (selectedFiles.size === 0 || !user) return;
    setIsDownloading(true);
    
    try {
      const zip = new JSZip();
      const filesToDownload = activeTab === 'rushes' 
        ? activeVideoFiles.filter(f => selectedFiles.has(f.id))
        : activeSourceFiles.filter(f => selectedFiles.has(f.id));

      for (const file of filesToDownload) {
        if (!file.videoUrl) continue;
        
        try {
          if (file.videoUrl.startsWith('local:')) {
            const fileId = file.videoUrl.split(':')[1];
            const localFile = await get(`file_${fileId}`);
            if (localFile) {
              zip.file(file.name, localFile as Blob);
            }
          } else {
            const blob = await downloadFileBlob(user, file);
            zip.file(file.name, blob);
          }
        } catch (err) {
          console.error("Failed to add file to zip:", file.name, err);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Project_${activeProject?.name || 'Export'}_${activeTab}_assets.zip`;
      a.click();
      URL.revokeObjectURL(url);
      
      setSelectedFiles(new Set()); // Clear selection after download
    } catch (err) {
      console.error("Failed to generate zip", err);
      alert("Failed to create ZIP package.");
    } finally {
      setIsDownloading(false);
    }
  };

  const [isDeleting, setIsDeleting] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<{ projectId: string, fileId: string, type: 'video' | 'source', name: string } | null>(null);

  const handleBulkDelete = async () => {
    if (selectedFiles.size === 0 || !activeProject) return;

    setIsDeleting(true);
    
    try {
      const type = activeTab === 'rushes' ? 'video' : 'source';
      const metadataList = type === 'video' ? activeVideoFiles : activeSourceFiles;
      const filesToDelete = metadataList.filter(file => selectedFiles.has(file.id));

      for (const file of filesToDelete) {
        await removeStoredFile({
          projectId: activeProject.id,
          file,
          type,
        });
      }

      setSelectedFiles(new Set()); // Clear selection after deletion
      setShowBulkDeleteConfirm(false);
    } catch (err) {
      console.error("Failed to delete selected files", err);
      alert("Failed to delete one or more files.");
    } finally {
      setIsDeleting(false);
    }
  };

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showBulkTagModal, setShowBulkTagModal] = useState(false);
  const [customTagsInput, setCustomTagsInput] = useState('');
  const [isGeneratingTags, setIsGeneratingTags] = useState(false);

  const handleGenerateCommonTags = async () => {
    if (selectedFiles.size === 0 || !activeProject || activeTab !== 'rushes') return;

    setIsGeneratingTags(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      // We only take up to 3 thumbnails to avoid payload overload
      const filesToAnalyze = activeVideoFiles
        .filter(f => selectedFiles.has(f.id) && f.previewUrl && f.previewUrl.startsWith('data:image/'))
        .slice(0, 3);
      
      if (filesToAnalyze.length === 0) {
        alert("No valid thumbnails found for AI analysis.");
        setIsGeneratingTags(false);
        return;
      }

      const parts: any[] = filesToAnalyze.map(f => ({
        inlineData: {
          mimeType: "image/jpeg",
          data: f.previewUrl!.split(',')[1],
        }
      }));

      parts.push({
        text: "Analyze these video keyframes. Identify 3-5 broad thematic or action tags that apply to ALL of them. Return ONLY a comma-separated list of tags (e.g. 'outdoor, action, bright')."
      });

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: { parts }
      });

      if (response.text) {
        setCustomTagsInput(response.text.trim());
      }
    } catch (err) {
      console.error("Failed to generate common tags", err);
      alert("Failed to generate common AI tags.");
    } finally {
      setIsGeneratingTags(false);
    }
  };

  const handleApplyBulkTags = async () => {
    if (selectedFiles.size === 0 || !activeProject) return;
    
    // Parse tags from input (comma-separated, trim whitespace, remove empty strings)
    const newTags = customTagsInput.split(',').map(t => t.trim()).filter(Boolean);
    if (newTags.length === 0) {
        setShowBulkTagModal(false);
        return;
    }

    try {
      const type = activeTab === 'rushes' ? 'video' : 'source';
      const filesToUpdate = Array.from(selectedFiles);
      
      const updatePromises = filesToUpdate.map(async (fileId) => {
        // Find existing tags so we don't duplicate them, or overwrite entirely.
        // Array union is a firestore feature, but because we might run concurrent local edits let's just 
        // pull the existing list from our local state, merge, and write it out.
        const metadataList = type === 'video' ? activeVideoFiles : activeSourceFiles;
        const currentMetadata = metadataList.find(f => f.id === fileId);
        const existingTags = currentMetadata?.customTags || [];
        
        // Combine keeping unique
        const mergedTags = Array.from(new Set([...existingTags, ...newTags]));

        try {
          await setDoc(
            doc(db, `projects/${activeProject.id}/${type}Files`, fileId as string), 
            { customTags: mergedTags }, 
            { merge: true }
          );
        } catch(e) {
          console.error(`Failed to update tags for ${fileId}`, e);
        }
      });

      await Promise.all(updatePromises);
      setSelectedFiles(new Set());
      setShowBulkTagModal(false);
      setCustomTagsInput('');
    } catch (err) {
      console.error("Failed to apply bulk tags", err);
    }
  };

  const handleBulkAnalyze = async () => {
    if (selectedFiles.size === 0 || !activeProject) return;
    
    // We only support analyzing video files via their preview frames for now
    if (activeTab !== 'rushes') {
      alert("AI Analysis is currently only supported for Video Rushes.");
      return;
    }

    setIsAnalyzing(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const filesToAnalyze = activeVideoFiles.filter(f => selectedFiles.has(f.id) && f.previewUrl && f.previewUrl.startsWith('data:image/'));

      const analysisPromises = filesToAnalyze.map(async (file) => {
        try {
          const base64Data = file.previewUrl!.split(',')[1];
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: base64Data,
                  },
                },
                {
                  text: `Analyze this keyframe extracted from a daily video rush named "${file.name}". Provide a brief 1-sentence summary of the scene, and up to 3 relevant concise tags (like 'b-roll', 'interview', 'outdoor', 'close-up').`
                }
              ]
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  summary: {
                    type: Type.STRING,
                    description: "A 1-sentence summary of the scene."
                  },
                  tags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "Up to 3 concise tags describing the contents."
                  }
                },
                required: ["summary", "tags"]
              }
            }
          });

          if (response.text) {
            const aiData = JSON.parse(response.text.trim());
            // Update Firestore document with AI data
            await setDoc(
              doc(db, `projects/${activeProject.id}/videoFiles`, file.id), 
              { aiAnalysis: aiData }, 
              { merge: true }
            );
          }
        } catch (err) {
          console.error(`Failed to analyze ${file.name}`, err);
        }
      });

      await Promise.all(analysisPromises);
      setSelectedFiles(new Set());
    } catch (err) {
      console.error("AI Analysis failed globally", err);
      alert("Failed to run AI analysis.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const logout = () => signOut(auth);

  const createProject = async () => {
    if (!newProjectName.trim() || !user) return;
    
    try {
      const projectData = {
        name: newProjectName,
        description: newProjectDescription,
        createdAt: serverTimestamp(),
        ownerId: user.uid
      };
      
      const docRef = await addDoc(collection(db, 'projects'), projectData);
      setActiveProjectId(docRef.id);
      setNewProjectName('');
      setNewProjectDescription('');
      setIsCreating(false);
    } catch (error) {
      handleFirestoreError(error, 'create', 'projects');
    }
  };

  const addFilesToProject = async (projectId: string, files: File[], type: 'video' | 'source') => {
    if (!user) return;

    setUploadingFiles(prev => [...prev, ...files.map(f => ({ file: f, type }))]);
    try {
      for (const file of files) {
        let cloudUpload: Awaited<ReturnType<typeof uploadFileToCloud>> | null = null;

        try {
          let previewUrl = '';
          
          if (type === 'video') {
            previewUrl = await generateVideoThumbnail(file);
          } else if (type === 'source') {
            if (file.type.startsWith('image/')) {
              previewUrl = await generateImageThumbnail(file);
            }
          }

          cloudUpload = await uploadFileToCloud(user, file);

          const fileData = {
            name: file.name,
            size: file.size,
            type: file.type,
            uploadedAt: serverTimestamp(),
            previewUrl: previewUrl,
            videoUrl: cloudUpload.videoUrl,
            type_group: type
          };

          await setDoc(doc(db, `projects/${projectId}/${type}Files`, cloudUpload.id), fileData);
        } catch (error) {
          if (cloudUpload) {
            try {
              await deleteCloudFile(user, cloudUpload.id);
            } catch (cleanupError) {
              console.error("Failed to clean up cloud upload after Firestore error:", cleanupError);
            }
          }

          console.error(`Failed to upload ${file.name}:`, error);
          alert(`Failed to upload ${file.name} to cloud storage.`);
        } finally {
          setUploadingFiles(prev => prev.filter(f => f.file !== file));
        }
      }
    } finally {
       setUploadingFiles(prev => prev.filter(f => !files.includes(f.file)));
    }
  };

  const confirmRemoveFile = async () => {
    if (!fileToDelete) return;
    try {
      const metadataList = fileToDelete.type === 'video' ? activeVideoFiles : activeSourceFiles;
      const file = metadataList.find(item => item.id === fileToDelete.fileId);

      if (file) {
        await removeStoredFile({
          projectId: fileToDelete.projectId,
          file,
          type: fileToDelete.type,
        });
      } else {
        await deleteDoc(doc(db, `projects/${fileToDelete.projectId}/${fileToDelete.type}Files`, fileToDelete.fileId));
      }
      
      if (selectedFiles.has(fileToDelete.fileId)) {
        const newSelected = new Set(selectedFiles);
        newSelected.delete(fileToDelete.fileId);
        setSelectedFiles(newSelected);
      }
      
      setFileToDelete(null);
    } catch (error) {
      handleFirestoreError(error, 'delete', `projects/${fileToDelete.projectId}/${fileToDelete.type}Files/${fileToDelete.fileId}`);
    }
  };

  const deleteProject = async (id: string) => {
    try {
      // Clean up known local files first to prevent orphaned data in Firestore
      // (A real production app might use a Cloud Function for deep cleanup)
      if (id === activeProjectId) {
        for (const file of activeVideoFiles) {
          await removeStoredFile({ projectId: id, file, type: 'video' }).catch((error) => {
            console.error("Failed to delete project video from storage", error);
          });
        }
        for (const file of activeSourceFiles) {
          await removeStoredFile({ projectId: id, file, type: 'source' }).catch((error) => {
            console.error("Failed to delete project asset from storage", error);
          });
        }
      }

      await deleteDoc(doc(db, 'projects', id));
      
      if (activeProjectId === id) setActiveProjectId(null);
      setDeleteConfirmId(null);
    } catch (error) {
      handleFirestoreError(error, 'delete', `projects/${id}`);
    }
  };

  if (authLoading) {
    return (
      <div className="h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
          <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-600">Syncing manifest...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen bg-[#0a0a0a] flex items-center justify-center p-8">
        <div className="max-w-md w-full text-center">
          <div className="bg-emerald-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-emerald-900/40">
            <Film className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-black tracking-tighter text-white mb-2 uppercase italic">RUSHES</h1>
          <p className="text-zinc-500 text-sm mb-12 lowercase tracking-tight leading-relaxed">
            authorized production personnel only. authenticate to access project archives and daily footage logs.
          </p>
          <Button className="w-full py-4 text-base" onClick={login}>
            <LogIn className="w-5 h-5 mr-3" />
            AUTHENTICATE WITH GOOGLE
          </Button>
          <div className="mt-8 flex items-center justify-center gap-4 opacity-20 filter grayscale">
             <div className="h-px bg-zinc-800 flex-1" />
             <ShieldCheck className="w-4 h-4 text-zinc-400" />
             <div className="h-px bg-zinc-800 flex-1" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-emerald-500/30 selection:text-emerald-200 uppercase tracking-tight">
      {/* Sidebar */}
      <aside className="w-72 border-r border-zinc-900 bg-[#0f0f0f] flex flex-col shrink-0">
        <div className="p-6 border-b border-zinc-900 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-600 p-2 rounded-lg shadow-lg shadow-emerald-900/20">
              <Film className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tighter text-white">RUSHES</h1>
          </div>
          <button onClick={logout} className="text-zinc-600 hover:text-zinc-400 transition-colors" title="De-authenticate">
            <LogOut className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-zinc-900">
          <Button 
            className="w-full justify-start gap-2" 
            onClick={() => {
              setIsCreating(true);
              setActiveProjectId(null);
            }}
          >
            <Plus className="w-4 h-4" />
            New Project
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {projects.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FolderOpen className="w-8 h-8 text-zinc-800 mx-auto mb-3" />
              <p className="text-zinc-600 text-[10px] uppercase tracking-wider">Empty Archives</p>
            </div>
          ) : (
            <div className="space-y-1">
              {projects.map(project => (
                <button
                  key={project.id}
                  onClick={() => {
                    setActiveProjectId(project.id);
                    setIsCreating(false);
                  }}
                  className={cn(
                    "w-full flex items-center justify-between p-3 rounded-lg text-[11px] transition-all group",
                    activeProjectId === project.id 
                      ? "bg-zinc-800/80 text-white" 
                      : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                  )}
                >
                  <div className="flex items-center gap-3 truncate">
                    <div className={cn(
                      "w-1 h-1 rounded-full",
                      activeProjectId === project.id ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-zinc-800"
                    )} />
                    <span className="truncate font-bold tracking-widest">{project.name}</span>
                  </div>
                  <ChevronRight className={cn(
                    "w-3 h-3 transition-transform",
                    activeProjectId === project.id ? "translate-x-0" : "-translate-x-2 opacity-0 group-hover:opacity-100 group-hover:translate-x-0"
                  )} />
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-zinc-900 flex items-center justify-between">
          <div className="flex items-center gap-2 px-2 py-0.5 opacity-50">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[9px] uppercase tracking-[0.2em] font-mono">Terminal Active</span>
          </div>
          <div className="flex items-center gap-2 px-2 text-zinc-600">
            <UserIcon className="w-3 h-3" />
            <span className="text-[9px] font-mono truncate max-w-[80px]">{user.email?.split('@')[0]}</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-[#0a0a0a]">
        {activeProject ? (
          <>
            {/* Project Header */}
            <header className="p-8 border-b border-zinc-900/50 bg-[#0f0f0f]/50 backdrop-blur-xl shrink-0">
              <div className="max-w-6xl mx-auto flex items-end justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-4 mb-3">
                    <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-500 px-2 py-0.5 rounded border border-emerald-900/30 bg-emerald-950/20">
                      Record_{activeProject.id.slice(0, 6)}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-600 flex items-center gap-1.5">
                      <Clock className="w-3 h-3" />
                      {format(activeProject.createdAt, 'MMM d, yyyy · HH:mm')}
                    </span>
                  </div>
                  <h2 className="text-4xl font-black tracking-tighter text-white truncate uppercase">{activeProject.name}</h2>
                  <p className="mt-2 text-zinc-500 max-w-2xl text-[11px] leading-relaxed lowercase tracking-normal line-clamp-2">
                    {activeProject.description || "not defined."}
                  </p>
                </div>
                <div className="flex items-center gap-2 pb-1 shrink-0">
                  <AnimatePresence mode="popLayout">
                    {deleteConfirmId === activeProject.id ? (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95, x: 20 }}
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.95, x: 20 }}
                        className="flex items-center gap-2 bg-red-950/40 p-1.5 rounded-lg border border-red-900/50"
                      >
                        <span className="text-[9px] text-red-400 font-mono uppercase tracking-widest px-2">Confirm Destroy?</span>
                        <Button variant="danger" size="sm" onClick={() => deleteProject(activeProject.id)}>
                          <span className="uppercase tracking-widest text-[9px] font-bold">Yes</span>
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmId(null)}>
                          <span className="uppercase tracking-widest text-[9px] font-bold">No</span>
                        </Button>
                      </motion.div>
                    ) : (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                      >
                        <Button variant="danger" size="sm" onClick={() => setDeleteConfirmId(activeProject.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                          <span className="ml-2 uppercase tracking-widest text-[9px] font-bold">Destroy</span>
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </header>

            {/* Project Grid */}
            <div className="flex-1 overflow-y-auto p-8 flex flex-col">
              <div className="max-w-6xl w-full mx-auto space-y-8 flex-1 flex flex-col pb-20">

                {/* Tabs Wrapper */}
                <div className="flex items-center gap-6 border-b border-zinc-900 pb-4 shrink-0">
                  <button
                    onClick={() => {
                      setActiveTab('rushes');
                      setSelectedFiles(new Set());
                    }}
                    className={cn(
                      "text-xs font-bold tracking-widest uppercase transition-colors flex items-center gap-2 px-3 py-2 -ml-2 rounded-md",
                      activeTab === 'rushes' ? "text-emerald-400 bg-emerald-950/30" : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-900/50"
                    )}
                  >
                    <FileVideo className="w-4 h-4" />
                    Rushes
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab('assets');
                      setSelectedFiles(new Set());
                    }}
                    className={cn(
                      "text-xs font-bold tracking-widest uppercase transition-colors flex items-center gap-2 px-3 py-2 rounded-md",
                      activeTab === 'assets' ? "text-blue-400 bg-blue-950/30" : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-900/50"
                    )}
                  >
                    <FileCode className="w-4 h-4" />
                    Assets
                  </button>
                </div>

                <AnimatePresence mode="wait">
                  {activeTab === 'rushes' ? (
                  <motion.section
                    key="rushes-tab"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.2 }}
                  >
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-emerald-900/20 rounded-md border border-emerald-900/30">
                        <FileVideo className="w-4 h-4 text-emerald-500" />
                      </div>
                      <h3 className="text-lg font-black text-white uppercase tracking-tight">RUSHES_LOG</h3>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] font-mono uppercase tracking-widest">
                      <button 
                        onClick={() => {
                          if (selectedFiles.size === activeVideoFiles.length && activeVideoFiles.length > 0) {
                            setSelectedFiles(new Set());
                          } else {
                            setSelectedFiles(new Set(activeVideoFiles.map(f => f.id)));
                          }
                        }}
                        className="text-emerald-500 hover:text-emerald-400 font-bold transition-colors"
                      >
                        {selectedFiles.size === activeVideoFiles.length && activeVideoFiles.length > 0 ? "Deselect All" : "Select All"}
                      </button>
                      <span className="text-zinc-600">
                        Count: {activeVideoFiles.length}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <FileDropzone 
                      onFilesAdded={(files) => addFilesToProject(activeProject.id, files, 'video')}
                      label="Upload Footage"
                      icon={<Upload className="w-5 h-5 text-emerald-500" />}
                      accept={{ 'video/*': [] }}
                    />

                    <AnimatePresence>
                      {uploadingFiles.filter(item => item.type === 'video').map((item, i) => (
                        <motion.div
                          key={`upload-${i}-${item.file.name}`}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="group relative bg-zinc-900/50 border border-emerald-900 rounded-xl overflow-hidden transition-all"
                        >
                          <div className="aspect-video bg-emerald-950/20 relative overflow-hidden flex flex-col items-center justify-center p-4">
                            <div className="w-8 h-8 rounded-full border-t-2 border-r-2 border-emerald-500 animate-spin mb-4" />
                            <p className="font-mono text-[10px] text-emerald-400 capitalize tabular-nums tracking-widest text-center truncate w-full">
                              Uploading...
                            </p>
                            <p className="text-[10px] text-zinc-500 font-mono text-center truncate w-full mt-1">
                              {item.file.name}
                            </p>
                          </div>
                        </motion.div>
                      ))}

                      {activeVideoFiles.map((file) => (
                        <motion.div
                          key={file.id}
                          layout
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className={cn(
                            "group relative overflow-hidden transition-all rounded-xl border",
                            selectedFiles.has(file.id) 
                              ? "bg-emerald-950/20 border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.15)]" 
                              : "bg-zinc-900/50 border-zinc-900 hover:border-zinc-700"
                          )}
                        >
                          <div 
                            className="aspect-video bg-zinc-900 relative overflow-hidden flex items-center justify-center cursor-pointer group/video"
                            onClick={() => {
                              if (selectedFiles.size > 0) {
                                toggleSelectStatus(file.id);
                              } else {
                                setPlayingVideo(file);
                              }
                            }}
                          >
                            {file.previewUrl ? (
                              <img 
                                src={file.previewUrl} 
                                alt={`${file.name} thumbnail`}
                                className={cn(
                                  "w-full h-full object-cover transition-opacity",
                                  selectedFiles.has(file.id) ? "opacity-70" : "opacity-40 group-hover/video:opacity-100"
                                )}
                              />
                            ) : (
                              <FileVideo className="w-10 h-10 text-zinc-800" />
                            )}
                            <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 to-transparent opacity-60 pointer-events-none" />
                            
                            {/* Checkbox overlay */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSelectStatus(file.id);
                              }}
                              className={cn(
                                "absolute top-3 left-3 z-20 flex items-center justify-center rounded transition-all",
                                selectedFiles.has(file.id) 
                                  ? "opacity-100 text-emerald-400" 
                                  : "opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-white"
                              )}
                            >
                              {selectedFiles.has(file.id) ? (
                                <PackageCheck className="w-5 h-5" />
                              ) : (
                                <Circle className="w-5 h-5" />
                              )}
                            </button>

                            <div className="absolute top-3 right-3 flex gap-1 transform translate-x-2 opacity-0 group-hover:translate-x-0 group-hover:opacity-100 transition-all scale-90 z-10">
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFileToDelete({ projectId: activeProject.id, fileId: file.id, type: 'video', name: file.name });
                                }}
                                className="p-2 bg-red-950/80 text-red-400 rounded-md hover:bg-red-900 border border-red-900/30"
                                title="Delete File"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                            <div className={cn(
                              "absolute inset-0 flex items-center justify-center transition-all pointer-events-none",
                              selectedFiles.has(file.id) ? "opacity-0" : "opacity-0 group-hover/video:opacity-100"
                            )}>
                                <div className="p-3 rounded-full bg-emerald-500 text-white shadow-2xl shadow-emerald-500/40">
                                  <Play className="w-4 h-4 fill-current ml-0.5" />
                                </div>
                            </div>
                          </div>
                          <div className={cn(
                            "p-4 transition-colors",
                            selectedFiles.has(file.id) ? "bg-emerald-950/40" : "bg-[#0f0f0f]"
                          )}>
                            <h4 className="text-zinc-200 font-bold truncate text-[11px] mb-1 tracking-wider uppercase" title={file.name}>{file.name}</h4>
                            <div className="flex items-center justify-between mb-3">
                              <span className="text-[9px] font-mono text-zinc-600 uppercase tabular-nums tracking-widest">{formatFileSize(file.size)}</span>
                              <span className="text-[9px] font-mono text-emerald-900 font-black uppercase tracking-widest bg-emerald-900/10 px-1 border border-emerald-900/20">DAILIES</span>
                            </div>
                            
                            {(file.aiAnalysis || (file.customTags && file.customTags.length > 0)) && (
                              <div className="pt-3 border-t border-zinc-900/50 space-y-2">
                                {file.aiAnalysis && (
                                  <p className="text-[10px] text-zinc-400 leading-relaxed italic line-clamp-2">
                                    "{file.aiAnalysis.summary}"
                                  </p>
                                )}
                                <div className="flex flex-wrap gap-1.5">
                                  {file.customTags?.map((tag, idx) => (
                                    <span key={`custom-${idx}`} className="text-[8px] font-mono uppercase tracking-widest bg-emerald-950/30 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-900/30">
                                      {tag}
                                    </span>
                                  ))}
                                  {file.aiAnalysis?.tags.map((tag, idx) => (
                                    <span key={`ai-${idx}`} className="text-[8px] font-mono uppercase tracking-widest bg-indigo-950/30 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-900/30">
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                  </motion.section>
                    ) : (

                  <motion.section
                  key="assets-tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-900/20 rounded-md border border-blue-900/30">
                        <FileCode className="w-4 h-4 text-blue-500" />
                      </div>
                      <h3 className="text-lg font-black text-white uppercase tracking-tight">ASSETS</h3>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] font-mono uppercase tracking-widest">
                      <button 
                        onClick={() => {
                          if (selectedFiles.size === activeSourceFiles.length && activeSourceFiles.length > 0) {
                            setSelectedFiles(new Set());
                          } else {
                            setSelectedFiles(new Set(activeSourceFiles.map(f => f.id)));
                          }
                        }}
                        className="text-blue-500 hover:text-blue-400 font-bold transition-colors"
                      >
                        {selectedFiles.size === activeSourceFiles.length && activeSourceFiles.length > 0 ? "Deselect All" : "Select All"}
                      </button>
                      <span className="text-zinc-600">
                        Count: {activeSourceFiles.length}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <FileDropzone 
                      onFilesAdded={(files) => addFilesToProject(activeProject.id, files, 'source')}
                      label="Ingest Assets"
                      icon={<Plus className="w-5 h-5 text-blue-500" />}
                    />

                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      <AnimatePresence>
                        {uploadingFiles.filter(item => item.type === 'source').map((item, i) => (
                           <motion.div
                            key={`upload-source-${i}-${item.file.name}`}
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="aspect-square bg-blue-950/20 border border-blue-900/50 rounded-xl relative overflow-hidden flex flex-col items-center justify-center p-4 transition-all"
                          >
                            <div className="w-8 h-8 border-t-2 border-r-2 border-blue-500 rounded-full animate-spin mb-3" />
                            <p className="text-[10px] font-bold text-zinc-300 truncate tracking-widest uppercase w-full text-center">{item.file.name}</p>
                            <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mt-1">Uploading...</p>
                           </motion.div>
                        ))}

                        {paginatedSourceFiles.map((file) => (
                          <motion.div
                            key={file.id}
                            layout
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className={cn(
                              "group relative aspect-square rounded-xl overflow-hidden transition-all flex flex-col cursor-pointer border",
                              selectedFiles.has(file.id)
                                ? "bg-blue-950/20 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.15)]"
                                : "bg-zinc-900/40 border-zinc-800 hover:border-zinc-700"
                            )}
                            onClick={() => toggleSelectStatus(file.id)}
                          >
                            <div className="flex-1 bg-zinc-950/50 flex items-center justify-center p-4 relative overflow-hidden">
                                {file.previewUrl ? (
                                  <img 
                                    src={file.previewUrl} 
                                    alt={`${file.name} preview`} 
                                    className={cn("w-full h-full object-contain transition-opacity", selectedFiles.has(file.id) ? "opacity-70" : "")} 
                                  />
                                ) : (
                                  getFileIcon(file.type || '', "w-12 h-12 text-zinc-700 group-hover:text-amber-500 transition-colors")
                                )}
                                
                                {/* Checkbox overlay */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleSelectStatus(file.id);
                                  }}
                                  className={cn(
                                    "absolute top-2 left-2 z-20 flex items-center justify-center rounded transition-all",
                                    selectedFiles.has(file.id) 
                                      ? "opacity-100 text-blue-400" 
                                      : "opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-white"
                                  )}
                                >
                                  {selectedFiles.has(file.id) ? (
                                    <PackageCheck className="w-5 h-5" />
                                  ) : (
                                    <Circle className="w-5 h-5" />
                                  )}
                                </button>

                                <div className={cn(
                                  "absolute inset-0 bg-black/60 transition-opacity flex items-center justify-center gap-2 pointer-events-none",
                                  selectedFiles.has(file.id) ? "opacity-0" : "opacity-0 group-hover:opacity-100"
                                )}>
                                  {file.videoUrl && (
                                    <button 
                                      className="p-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-md transition-colors pointer-events-auto"
                                      title="Download"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        if (!user) {
                                          return;
                                        }

                                        try {
                                          const blob = file.videoUrl?.startsWith('local:')
                                            ? await get(`file_${file.videoUrl.split(':')[1]}`) as Blob | undefined
                                            : await downloadFileBlob(user, file);

                                          if (!blob) {
                                            alert("File missing from storage.");
                                            return;
                                          }

                                          const url = URL.createObjectURL(blob);
                                          const a = document.createElement('a');
                                          a.href = url;
                                          a.download = file.name;
                                          a.click();
                                          URL.revokeObjectURL(url);
                                        } catch (error) {
                                          console.error("Failed to download asset", error);
                                          alert("Failed to download file.");
                                        }
                                      }}
                                    >
                                      <Download className="w-4 h-4" />
                                    </button>
                                  )}
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setFileToDelete({ projectId: activeProject.id, fileId: file.id, type: 'source', name: file.name });
                                    }}
                                    className="p-2 bg-red-950/90 text-red-400 hover:text-white hover:bg-red-900 rounded-md transition-colors pointer-events-auto"
                                    title="Delete"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                            </div>
                            <div className={cn("p-3 border-t flex flex-col min-h-[50px] shrink-0 transition-colors", selectedFiles.has(file.id) ? "bg-blue-950/40 border-blue-900/50" : "bg-[#0f0f0f] border-zinc-800")}>
                                <p className="text-[10px] font-bold text-zinc-300 truncate tracking-widest uppercase mb-1" title={file.name}>{file.name}</p>
                                <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
                                  {formatFileSize(file.size)}
                                </p>
                                
                                {(file.aiAnalysis || (file.customTags && file.customTags.length > 0)) && (
                                  <div className="pt-2 mt-2 border-t border-zinc-900/50 space-y-2">
                                    {file.aiAnalysis && (
                                      <p className="text-[10px] text-zinc-400 leading-relaxed italic line-clamp-2">
                                        "{file.aiAnalysis.summary}"
                                      </p>
                                    )}
                                    <div className="flex flex-wrap gap-1.5">
                                      {file.customTags?.map((tag, idx) => (
                                        <span key={`custom-${idx}`} className="text-[8px] font-mono uppercase tracking-widest bg-emerald-950/30 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-900/30">
                                          {tag}
                                        </span>
                                      ))}
                                      {file.aiAnalysis?.tags.map((tag, idx) => (
                                        <span key={`ai-${idx}`} className="text-[8px] font-mono uppercase tracking-widest bg-indigo-950/30 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-900/30">
                                          {tag}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                            </div>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>

                    {totalAssetPages > 1 && (
                      <div className="flex items-center justify-center gap-4 mt-8 pt-4">
                        <Button 
                          variant="secondary" 
                          size="sm" 
                          onClick={() => setAssetPage(p => Math.max(1, p - 1))} 
                          disabled={currentAssetPage === 1}
                        >
                          PREV
                        </Button>
                        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
                          {currentAssetPage} / {totalAssetPages}
                        </span>
                        <Button 
                          variant="secondary" 
                          size="sm" 
                          onClick={() => setAssetPage(p => Math.min(totalAssetPages, p + 1))} 
                          disabled={currentAssetPage === totalAssetPages}
                        >
                          NEXT
                        </Button>
                      </div>
                    )}
                  </div>
                </motion.section>
                  )}
                </AnimatePresence>
              </div>

              {/* Bulk Action Bar */}
              <AnimatePresence>
                {selectedFiles.size > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 50, x: '-50%' }}
                    animate={{ opacity: 1, y: 0, x: '-50%' }}
                    exit={{ opacity: 0, y: 50, x: '-50%' }}
                    className="fixed bottom-8 left-1/2 z-50 flex items-center gap-4 bg-[#0f0f0f]/90 backdrop-blur-md border border-zinc-800 rounded-full px-6 py-3 shadow-2xl shadow-black/50"
                  >
                    <div className="flex items-center gap-2 border-r border-zinc-800 pr-4">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-500 text-[11px] font-bold">
                        {selectedFiles.size}
                      </div>
                      <span className="text-[10px] uppercase tracking-widest font-mono text-zinc-400">Selected</span>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <Button 
                        size="sm" 
                        onClick={() => setShowBulkTagModal(true)}
                        disabled={isDownloading || isDeleting || isAnalyzing || isGeneratingTags}
                        className="bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-white flex items-center gap-2 px-4 min-w-[120px] justify-center transition-colors"
                      >
                        <Tag className="w-3.5 h-3.5" />
                        <span className="text-[10px] uppercase font-bold tracking-widest">Tag Selected</span>
                      </Button>
                      
                      {activeTab === 'rushes' && (
                        <Button 
                          size="sm" 
                          onClick={handleBulkAnalyze}
                          disabled={isDownloading || isDeleting || isAnalyzing}
                          className="bg-indigo-900/60 border border-indigo-700/50 text-indigo-300 hover:bg-indigo-700/80 hover:text-white flex items-center gap-2 px-4 shadow-[0_0_15px_rgba(79,70,229,0.2)] min-w-[140px] justify-center transition-colors"
                        >
                          {isAnalyzing ? (
                            <>
                              <div className="w-3.5 h-3.5 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" />
                              <span className="text-[10px] tracking-widest font-bold">Analyzing...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5" />
                              <span className="text-[10px] uppercase font-bold tracking-widest">Interpret AI</span>
                            </>
                          )}
                        </Button>
                      )}
                      <Button 
                        size="sm" 
                        onClick={handleBulkDownload}
                        disabled={isDownloading || isDeleting || isAnalyzing}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-2 px-4 shadow-[0_0_15px_rgba(16,185,129,0.3)] min-w-[140px] justify-center"
                      >
                        {isDownloading ? (
                          <>
                            <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            <span className="text-[10px] tracking-widest font-bold">Zipping...</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-3.5 h-3.5" />
                            <span className="text-[10px] uppercase font-bold tracking-widest">Download All</span>
                          </>
                        )}
                      </Button>
                      <Button 
                        size="sm" 
                        onClick={() => setShowBulkDeleteConfirm(true)}
                        disabled={isDownloading || isDeleting || isAnalyzing}
                        className="bg-red-950/80 border border-red-900 text-red-400 hover:bg-red-900 hover:text-white flex items-center gap-2 px-4 min-w-[120px] justify-center transition-colors hover:shadow-[0_0_15px_rgba(220,38,38,0.3)]"
                      >
                        {isDeleting ? (
                          <>
                            <div className="w-3.5 h-3.5 border-2 border-red-400/30 border-t-red-400 rounded-full animate-spin" />
                            <span className="text-[10px] tracking-widest font-bold">Deleting...</span>
                          </>
                        ) : (
                          <>
                            <Trash2 className="w-3.5 h-3.5" />
                            <span className="text-[10px] uppercase font-bold tracking-widest">Delete All</span>
                          </>
                        )}
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => setSelectedFiles(new Set())}
                        className="text-zinc-500 hover:text-white px-3 ml-2"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Custom Bulk Delete Confirmation Modal */}
              <AnimatePresence>
                {showBulkDeleteConfirm && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                  >
                    <motion.div
                      initial={{ scale: 0.95, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.95, opacity: 0 }}
                      className="bg-[#0f0f0f] border border-zinc-800 rounded-2xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden"
                    >
                       <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/10 blur-[80px] rounded-full" />
                       <div className="relative z-10 flex flex-col items-center text-center">
                         <div className="w-16 h-16 rounded-full bg-red-950/50 border border-red-900/50 flex items-center justify-center mb-6">
                           <Trash2 className="w-8 h-8 text-red-500" />
                         </div>
                         <h3 className="text-xl font-black text-white uppercase tracking-tight mb-2">Confirm Deletion</h3>
                         <p className="text-sm text-zinc-400 mb-8">
                           Are you sure you want to permanently delete <strong className="text-white">{selectedFiles.size}</strong> selected items? This action cannot be undone.
                         </p>
                         <div className="flex items-center gap-4 w-full">
                           <Button
                             variant="secondary"
                             className="flex-1 py-3 text-xs tracking-[0.2em] uppercase font-bold"
                             onClick={() => setShowBulkDeleteConfirm(false)}
                             disabled={isDeleting}
                           >
                             Cancel
                           </Button>
                           <Button
                             className="flex-1 py-3 text-xs tracking-[0.2em] uppercase font-bold bg-red-600 hover:bg-red-500 text-white border-0"
                             onClick={handleBulkDelete}
                             disabled={isDeleting}
                           >
                             {isDeleting ? "Processing..." : "Confirm Delete"}
                           </Button>
                         </div>
                       </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Single File Delete Confirmation Modal */}
              <AnimatePresence>
                {fileToDelete && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                  >
                    <motion.div
                      initial={{ scale: 0.95, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.95, opacity: 0 }}
                      className="bg-[#0f0f0f] border border-zinc-800 rounded-2xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden"
                    >
                       <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/10 blur-[80px] rounded-full" />
                       <div className="relative z-10 flex flex-col items-center text-center">
                         <div className="w-16 h-16 rounded-full bg-red-950/50 border border-red-900/50 flex items-center justify-center mb-6">
                           <Trash2 className="w-8 h-8 text-red-500" />
                         </div>
                         <h3 className="text-xl font-black text-white uppercase tracking-tight mb-2">Delete File</h3>
                         <p className="text-sm text-zinc-400 mb-8">
                           Are you sure you want to delete <strong className="text-white">{fileToDelete.name}</strong>? This action cannot be undone.
                         </p>
                         <div className="flex items-center gap-4 w-full">
                           <Button
                             variant="secondary"
                             className="flex-1 py-3 text-xs tracking-[0.2em] uppercase font-bold"
                             onClick={() => setFileToDelete(null)}
                           >
                             Cancel
                           </Button>
                           <Button
                             className="flex-1 py-3 text-xs tracking-[0.2em] uppercase font-bold bg-red-600 hover:bg-red-500 text-white border-0"
                             onClick={confirmRemoveFile}
                           >
                             Delete File
                           </Button>
                         </div>
                       </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Bulk Tagging Modal */}
              <AnimatePresence>
                {showBulkTagModal && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                  >
                    <motion.div
                      initial={{ scale: 0.95, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.95, opacity: 0 }}
                      className="bg-[#0f0f0f] border border-zinc-800 rounded-2xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden"
                    >
                       <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-600/10 blur-[80px] rounded-full" />
                       <div className="relative z-10 flex flex-col items-center">
                         <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-6">
                           <Tag className="w-8 h-8 text-zinc-400" />
                         </div>
                         <h3 className="text-xl font-black text-white uppercase tracking-tight mb-2">Tag Selected Files</h3>
                         <p className="text-sm text-zinc-400 mb-8 text-center">
                           Apply common tags to <strong className="text-white">{selectedFiles.size}</strong> selected items.
                         </p>

                         <div className="w-full mb-6 space-y-3">
                           <input 
                             type="text" 
                             placeholder="e.g. b-roll, exterior, day"
                             className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-all font-mono text-sm tracking-wider"
                             value={customTagsInput}
                             onChange={(e) => setCustomTagsInput(e.target.value)}
                             autoFocus
                           />
                           
                           {activeTab === 'rushes' && (
                             <Button 
                               variant="secondary"
                               className="w-full py-3 text-[10px] tracking-widest font-mono uppercase bg-indigo-950/20 text-indigo-400 hover:bg-indigo-900/40 border border-indigo-900/30 flex items-center justify-center gap-2"
                               onClick={handleGenerateCommonTags}
                               disabled={isGeneratingTags}
                             >
                               {isGeneratingTags ? (
                                 <><div className="w-3 h-3 border border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" /> Suggesting...</>
                               ) : (
                                 <><Sparkles className="w-3 h-3" /> Auto-Suggest Common AI Tags</>
                               )}
                             </Button>
                           )}
                         </div>

                         <div className="flex items-center gap-4 w-full">
                           <Button
                             variant="secondary"
                             className="flex-1 py-3 text-xs tracking-[0.2em] uppercase font-bold"
                             onClick={() => setShowBulkTagModal(false)}
                           >
                             Cancel
                           </Button>
                           <Button
                             className="flex-1 py-3 text-xs tracking-[0.2em] uppercase font-bold bg-white text-black hover:bg-zinc-200 border-0"
                             onClick={handleApplyBulkTags}
                           >
                             Apply Tags
                           </Button>
                         </div>
                       </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

            </div>
          </>
        ) : isCreating ? (
          <div className="flex-1 flex items-center justify-center p-8 bg-zinc-950">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-xl w-full bg-[#0f0f0f] border border-zinc-900 rounded-2xl p-12 shadow-2xl relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-600/5 blur-[100px] rounded-full" />
              
              <div className="relative">
                <div className="flex items-center gap-4 mb-10">
                  <div className="bg-emerald-600 p-3 rounded-xl shadow-xl shadow-emerald-900/30">
                    <Plus className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <h2 className="text-3xl font-black tracking-tighter text-white uppercase italic">NEW_RECORD</h2>
                    <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest mt-1">Specify Metadata</p>
                  </div>
                </div>

                <div className="space-y-8">
                  <div>
                    <label className="block text-[9px] font-mono uppercase tracking-[0.3em] text-zinc-600 mb-3">01 // IDENTITY</label>
                    <input 
                      type="text" 
                      placeholder="PROJECT_SLUG"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-4 text-white placeholder:text-zinc-800 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20 transition-all font-mono text-sm tracking-wider uppercase"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value.toUpperCase().replace(/\s+/g, '_'))}
                      autoFocus
                    />
                  </div>

                  <div>
                    <label className="block text-[9px] font-mono uppercase tracking-[0.3em] text-zinc-600 mb-3">02 // DESCRIPTION</label>
                    <textarea 
                      placeholder="Briefing and technical requirements..."
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-4 text-zinc-300 placeholder:text-zinc-800 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20 transition-all text-[11px] min-h-[140px] resize-none tracking-normal lowercase leading-relaxed"
                      value={newProjectDescription}
                      onChange={(e) => setNewProjectDescription(e.target.value)}
                    />
                  </div>

                  <div className="flex gap-4 pt-6">
                    <Button 
                      className="flex-3 py-4 text-xs tracking-[0.2em] font-black" 
                      onClick={createProject} 
                      disabled={!newProjectName.trim()}
                    >
                      INITIALIZE_CAPTURE
                    </Button>
                    <Button 
                      variant="secondary" 
                      className="flex-1 py-4 text-xs tracking-[0.2em]"
                      onClick={() => setIsCreating(false)}
                    >
                      ABORT
                    </Button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#0a0a0a]">
            {/* Landing UI */}
            <div className="text-center max-w-lg">
              <div className="inline-flex flex-col items-center mb-16">
                <div className="relative mb-12">
                   <div className="absolute inset-0 bg-emerald-500/20 blur-[100px] rounded-full" />
                   <motion.div 
                     animate={{ rotate: [0, 90, 180, 270, 360] }}
                     transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
                     className="p-12 border border-zinc-900 rounded-full relative bg-[#0f0f0f]/50 backdrop-blur-sm"
                   >
                     <Film className="w-16 h-16 text-emerald-500" />
                   </motion.div>
                   <div className="absolute -bottom-2 -right-2 bg-emerald-600 w-6 h-6 rounded-full border-4 border-[#0a0a0a] animate-pulse" />
                </div>
                <h2 className="text-7xl font-black tracking-tighter text-white mb-6 uppercase italic">READY_</h2>
                <p className="text-zinc-600 text-[11px] leading-relaxed mb-10 max-w-xs font-mono uppercase tracking-widest">
                  System operational. Select a production record or initialize a new capture session.
                </p>
                <div className="flex flex-col items-center gap-6 w-full px-12">
                  <Button className="w-full py-5 text-sm tracking-[0.3em] font-black" onClick={() => setIsCreating(true)}>
                    NEW_CAPTURE_SESSION
                  </Button>
                  <div className="flex items-center gap-6 opacity-40">
                    <span className="text-[9px] font-mono text-zinc-700 uppercase tracking-[0.4em]">VER. 1.0.42</span>
                    <span className="text-[9px] font-mono text-zinc-700 uppercase tracking-[0.4em]">CORE_SYNC: OK</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-12 border-t border-zinc-900 pt-16 text-left opacity-30">
                  <div>
                    <h4 className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                       <LayoutGrid className="w-3 h-3" />
                       DAILIES_LOG
                    </h4>
                    <p className="text-[10px] text-zinc-600 uppercase tracking-tighter">Automated metadata mapping for raw production rushes.</p>
                  </div>
                  <div>
                    <h4 className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                       <ListIcon className="w-3 h-3" />
                       ASSETS
                    </h4>
                    <p className="text-[10px] text-zinc-600 uppercase tracking-tighter">Secure distribution portal for audio stems and LUTS.</p>
                  </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <AnimatePresence>
        {playingVideo && (
          <VideoModal playingVideo={playingVideo} setPlayingVideo={setPlayingVideo} />
        )}
      </AnimatePresence>
    </div>
  );
}
