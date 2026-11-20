import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/file_entity.dart';
import '../models/upload_status.dart';
import '../repositories/file_repository.dart';
import '../routes.dart';

class FileListPage extends StatelessWidget {
  const FileListPage({super.key});

  @override
  Widget build(BuildContext context) {
    final fileRepository = context.watch<IFileRepository>();
    
    return Scaffold(
      appBar: AppBar(
        title: const Text('Files'),
        actions: [
          IconButton(
            icon: const Icon(Icons.upload),
            onPressed: () {
              // Navigate to upload screen
              Routes.navKey.currentState?.pushNamed('/upload');
            },
          ),
        ],
      ),
      body: FutureBuilder<
        List<FileEntity>
      >(
        future: fileRepository.getAllAsync(),
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          
          final files = snapshot.data ?? [];
          
          if (files.isEmpty) {
            return _buildEmptyState(context);
          }
          
          return ListView.builder(
            itemCount: files.length,
            itemBuilder: (context, index) {
              final file = files[index];
              
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: ListTile(
                  leading: _getStatusIcon(file.status),
                  title: Text(
                    file.fileName,
                    style: const TextStyle(fontFamily: 'OpenSans'),
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Size: ${(file.fileSize / 1024).toStringAsFixed(1)} KB',
                        style: const TextStyle(fontSize: 12),
                      ),
                      Text(
                        'Status: ${file.status.displayName}',
                        style: TextStyle(
                          color: file.status.statusColor,
                          fontSize: 12,
                        ),
                      ),
                      if (file.errorMessage != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          'Error: ${file.errorMessage}',
                          style: const TextStyle(
                            color: Color(0xFFB00020),
                            fontSize: 12,
                            fontStyle: FontStyle.italic,
                          ),
                        ),
                      ],
                    ],
                  ),
                  trailing: _getStatusActions(file),
                  onTap: () => _onFileTap(context, file),
                ),
              );
            },
          );
        },
      ),
    );
  }

  Widget _getStatusIcon(UploadStatus status) {
    final color = status.statusColor;
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Icon(
        _getIconForStatus(status),
        color: color,
        size: 20,
      ),
    );
  }

  IconData _getIconForStatus(UploadStatus status) {
    switch (status) {
      case UploadStatus.pending: return Icons.file_download;
      case UploadStatus.uploading: return Icons.upload;
      case UploadStatus.uploaded: return Icons.check_circle;
      case UploadStatus.failed: return Icons.error;
      case UploadStatus.retrying: return Icons.refresh;
      case UploadStatus.completed: return Icons.done;
      default: return Icons.insert_drive_file;
    }
  }

  Widget _getStatusActions(FileEntity file) {
    // Show action buttons based on status
    return PopupMenuButton<String>(
      onSelected: (String? value) {
        // Handle menu selection
      },
      itemBuilder: (_) => [
        if (file.status == UploadStatus.failed || file.status == UploadStatus.retrying)
          const PopupMenuItem(
            value: 'retry',
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.refresh, size: 16),
                SizedBox(width: 4),
                Text('Retry'),
              ],
            ),
          ),
        if (file.status == UploadStatus.pending)
          const PopupMenuItem(
            value: 'details',
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.info, size: 16),
                SizedBox(width: 4),
                Text('Details'),
              ],
            ),
          ),
      ],
      child: const Icon(Icons.more_vert),
    );
  }

  void _onFileTap(BuildContext context, FileEntity file) {
    // Navigate to file details or open options
    // Could show a dialog with options: retry, cancel, copy path, etc.
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('File: ${file.fileName}'),
        action: SnackBarAction(
          label: 'Details',
          onPressed: () {
            // Show file details
          },
        ),
      ),
    );
  }

  Widget _buildEmptyState(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.file_upload,
            size: 64,
            color: Colors.grey[300],
          ),
          const SizedBox(height: 16),
          const Text(
            'No files found',
            style: TextStyle(
              fontSize: 18,
              color: Colors.grey,
              fontFamily: 'OpenSans',
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Add folders to scan for media files',
            style: TextStyle(fontSize: 14, color: Colors.grey),
          ),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: () {
              // Navigate to folder configuration
              Routes.navKey.currentState?.pushNamed('/folders');
            },
            icon: const Icon(Icons.add),
            label: const Text('Add Folders'),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF512BD4),
            ),
          ),
        ],
      ),
    );
  }
}