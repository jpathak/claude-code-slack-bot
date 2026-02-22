import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import sharp from 'sharp';
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
   * Uses sharp library (cross-platform) to:
   * - Convert HEIC/HEIF/TIFF to PNG
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
      // Get image metadata to check dimensions
      const metadata = await sharp(imagePath).metadata();

      if (metadata.width && metadata.height) {
        this.logger.debug('Image dimensions', {
          path: imagePath,
          width: metadata.width,
          height: metadata.height
        });
      }

      // Determine if we need to resize the image
      const needsResize = metadata.width && metadata.height &&
        (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION);

      if (!needsConversion && !needsResize && mimetype === 'image/png') {
        // Image is already PNG and within size limits, no processing needed
        return imagePath;
      }

      // Build sharp pipeline
      let pipeline = sharp(imagePath);

      // Resize if needed (maintain aspect ratio by setting max dimension)
      if (needsResize && metadata.width && metadata.height) {
        const maxDim = Math.max(metadata.width, metadata.height);
        const scale = MAX_IMAGE_DIMENSION / maxDim;
        const newWidth = Math.floor(metadata.width * scale);
        const newHeight = Math.floor(metadata.height * scale);

        pipeline = pipeline.resize(newWidth, newHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        });

        this.logger.info('Resizing image', {
          from: `${metadata.width}x${metadata.height}`,
          to: `${newWidth}x${newHeight}`
        });
      }

      // Convert to PNG
      await pipeline.png().toFile(outputPath);

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
