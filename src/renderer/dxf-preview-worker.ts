import { DxfViewer } from 'dxf-viewer';

// Parsing and geometry preparation stay off the application UI thread.
DxfViewer.SetupWorker();
