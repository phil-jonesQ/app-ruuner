export interface Project {
  id: string;
  name: string;
  description: string;
  hasDist: boolean;
  hasPackageJson: boolean;
  path: string;
}

export interface BuildResponse {
  success: boolean;
  logs: string;
  error?: string;
  details?: string;
}