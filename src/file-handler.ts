import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { Logger } from './logger.js';
import { config } from './config.js';

export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  size: number;
  tempPath?: string;
  preprocessedPath?: string;
}

// Maximum image dimensions for Claude API (8192x8192 is the limit)
const MAX_IMAGE_DIMENSION = 4096; // Use conservative limit to avoid issues

export class FileHandler {
  private logger = new Logger('FileHandler');

  /**
   * Preprocess an image to ensure compatibility with Claude's API.
   * Uses macOS `sips` command to:
   * - Convert HEIC/HEIF to PNG
   * - Resize large images
   * - Normalize color profiles
   */
  private async preprocessImage(imagePath: string, mimetype: string): Promise<string> {
    const needsConversion = mimetype === 'image/heic' ||
                           mimetype === 'image/heif' ||
                           mimetype === 'image/tiff' ||
                           mimetype.includes('heic') ||
                           mimetype.includes('heif');

    // Generate output path (always convert to PNG for consistency)
    const outputPath = imagePath.replace(/\.[^.]+$/, '.png');

    try {
      // First, get image dimensions to check if resize is needed
      const dimensions = await this.getImageDimensions(imagePath);

      if (dimensions) {
        this.logger.debug('Image dimensions', {
          path: imagePath,
          width: dimensions.width,
          height: dimensions.height
        });
      }

      // Determine if we need to process the image
      const needsResize = dimensions &&
        (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION);

      if (!needsConversion && !needsResize && mimetype === 'image/png') {
        // Image is already PNG and within size limits, no processing needed
        return imagePath;
      }

      // Use sips to convert and/or resize the image
      const args: string[] = [];

      // Set format to PNG
      args.push('-s', 'format', 'png');

      // Resize if needed (maintain aspect ratio by setting max dimension)
      if (needsResize) {
        const maxDim = Math.max(dimensions!.width, dimensions!.height);
        const scale = MAX_IMAGE_DIMENSION / maxDim;
        const newWidth = Math.floor(dimensions!.width * scale);
        const newHeight = Math.floor(dimensions!.height * scale);
        args.push('-z', String(newHeight), String(newWidth));
        this.logger.info('Resizing image', {
          from: `${dimensions!.width}x${dimensions!.height}`,
          to: `${newWidth}x${newHeight}`
        });
      }

      // Output path
      args.push('--out', outputPath);

      // Input path
      args.push(imagePath);

      await this.runCommand('sips', args);

      this.logger.info('Image preprocessed successfully', {
        input: imagePath,
        output: outputPath,
        converted: needsConversion,
        resized: needsResize
      });

      return outputPath;
    } catch (error) {
      this.logger.warn('Image preprocessing failed, using original', {
        path: imagePath,
        error: error instanceof Error ? error.message : String(error)
      });
      // Return original path if preprocessing fails
      return imagePath;
    }
  }

  /**
   * Get image dimensions using sips
   */
  private async getImageDimensions(imagePath: string): Promise<{ width: number; height: number } | null> {
    try {
      const output = await this.runCommand('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath]);

      const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
      const heightMatch = output.match(/pixelHeight:\s*(\d+)/);

      if (widthMatch && heightMatch) {
        return {
          width: parseInt(widthMatch[1], 10),
          height: parseInt(heightMatch[1], 10)
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Run a command and return its output
   */
  private runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  async downloadAndProcessFiles(files: any[]): Promise<ProcessedFile[]> {
    const processedFiles: ProcessedFile[] = [];

    for (const file of files) {
      try {
        const processed = await this.downloadFile(file);
        if (processed) {
          processedFiles.push(processed);
        }
      } catch (error) {
        this.logger.error(`Failed to process file ${file.name}`, error);
      }
    }

    return processedFiles;
  }

  private async downloadFile(file: any): Promise<ProcessedFile | null> {
    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
      return null;
    }

    try {
      this.logger.debug('Downloading file', { name: file.name, mimetype: file.mimetype });

      const response = await fetch(file.url_private_download, {
        headers: {
          'Authorization': `Bearer ${config.slack.botToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.buffer();
      const tempDir = os.tmpdir();
      const tempPath = path.join(tempDir, `slack-file-${Date.now()}-${file.name}`);
      
      fs.writeFileSync(tempPath, buffer);

      const isImage = this.isImageFile(file.mimetype);
      let finalPath = tempPath;

      // Preprocess images to ensure compatibility with Claude's API
      if (isImage) {
        finalPath = await this.preprocessImage(tempPath, file.mimetype);
      }

      const processed: ProcessedFile = {
        path: finalPath,
        name: file.name,
        mimetype: (isImage && finalPath !== tempPath) ? 'image/png' : file.mimetype,
        isImage,
        isText: this.isTextFile(file.mimetype),
        size: file.size,
        tempPath, // keep original temp path for cleanup
      };

      // Track preprocessed file for cleanup if different from original
      if (finalPath !== tempPath) {
        processed.preprocessedPath = finalPath;
      }

      this.logger.info('File downloaded successfully', {
        name: file.name,
        tempPath,
        finalPath,
        isImage: processed.isImage,
        isText: processed.isText,
        preprocessed: finalPath !== tempPath,
      });

      return processed;
    } catch (error) {
      this.logger.error('Failed to download file', error);
      return null;
    }
  }

  private isImageFile(mimetype: string): boolean {
    return mimetype.startsWith('image/');
  }

  private isTextFile(mimetype: string): boolean {
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
    ];

    return textTypes.some(type => mimetype.startsWith(type));
  }

  async formatFilePrompt(files: ProcessedFile[], userText: string): Promise<string> {
    let prompt = userText || 'Please analyze the uploaded files.';
    
    if (files.length > 0) {
      prompt += '\n\nUploaded files:\n';
      
      for (const file of files) {
        if (file.isImage) {
          prompt += `\n## Image: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Path: ${file.path}\n`;
          prompt += `Note: This is an image file that has been uploaded. You can analyze it using the Read tool to examine the image content.\n`;
        } else if (file.isText) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          
          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > 10000) {
              prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
            } else {
              prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
            }
          } catch (error) {
            prompt += `Error reading file content: ${error}\n`;
          }
        } else {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: This is a binary file. Content analysis may be limited.\n`;
        }
      }
      
      prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
    }

    return prompt;
  }

  async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
    for (const file of files) {
      if (file.tempPath) {
        try {
          fs.unlinkSync(file.tempPath);
          this.logger.debug('Cleaned up temp file', { path: file.tempPath });
        } catch (error) {
          this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
        }
      }
      // Also clean up preprocessed file if it's different from the original
      if (file.preprocessedPath && file.preprocessedPath !== file.tempPath) {
        try {
          fs.unlinkSync(file.preprocessedPath);
          this.logger.debug('Cleaned up preprocessed file', { path: file.preprocessedPath });
        } catch (error) {
          this.logger.warn('Failed to cleanup preprocessed file', { path: file.preprocessedPath, error });
        }
      }
    }
  }

  getSupportedFileTypes(): string[] {
    return [
      'Images: jpg, png, gif, webp, svg',
      'Text files: txt, md, json, js, ts, py, java, etc.',
      'Documents: pdf, docx (limited support)',
      'Code files: most programming languages',
    ];
  }
}