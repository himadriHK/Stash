import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/folder_config.dart';
import '../providers/app_config.dart';
import '../repositories/folder_repository.dart';

class FolderConfigPage extends StatelessWidget {
  const FolderConfigPage({super.key});

  @override
  Widget build(BuildContext context) {
    final folderRepository = context.watch<FolderRepository>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Folders'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: () => _addFolder(context),
          ),
        ],
      ),
      body: FutureBuilder<
        List<FolderConfig>
      >(
        future: folderRepository.getAllAsync(),
        builder: (context, snapshot) {
          final folders = snapshot.data ?? [];

          if (folders.isEmpty) {
            return _buildEmptyState(context);
          }

          return ListView.builder(
            itemCount: folders.length,
            itemBuilder: (context, index) {
              final folder = folders[index];
              return _buildFolderTile(context, folder);
            },
          );
        },
      ),
    );
  }

  void _addFolder(BuildContext context) {
    final _folderController = TextEditingController();

    showDialog(
      context: context,
      builder: (alert) => AlertDialog(
        title: const Text('Add Folder'),
        content: TextField(
          controller: _folderController,
          decoration: const InputDecoration(
            hintText: 'Select folder path',
            labelText: 'Folder Path',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(alert).pop(),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () {
              final path = _folderController.text.trim();
              if (path.isNotEmpty) {
                final folder = FolderConfig(
                  folderPath: path,
                  folderName: path.split('/').last,
                );
                context.read<FolderRepository>().addAsync(folder);
                Navigator.of(alert).pop();
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Folder added successfully'),
                    backgroundColor: Color(0xFF512BD4),
                  ),
                );
              }
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );
  }

  Widget _buildFolderTile(BuildContext context, FolderConfig folder) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: ListTile(
        leading: Icon(
          folder.isEnabled ? Icons.folder : Icons.folder_off,
          color: folder.isEnabled ? null : Colors.grey,
        ),
        title: Text(
          folder.folderName,
          style: const TextStyle(fontFamily: 'OpenSans'),
        ),
        subtitle: Text(
          folder.folderPath,
          style: const TextStyle(
            fontSize: 12,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        trailing: Switch(
          value: folder.isEnabled,
          activeThumbColor: const Color(0xFF512BD4),
          onChanged: (value) => _toggleFolder(context, folder.id, value),
        ),
        onTap: () => _onFolderTap(context, folder),
      ),
    );
  }

  Widget _buildEmptyState(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.search,
            size: 64,
            color: Colors.grey[300],
          ),
          const SizedBox(height: 16),
          const Text(
            'No configured folders',
            style: TextStyle(
              fontSize: 18,
              color: Colors.grey,
              fontFamily: 'OpenSans',
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Add a folder to start scanning and uploading files',
            style: TextStyle(fontSize: 14, color: Colors.grey),
          ),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: () => _addFolder(context),
            icon: const Icon(Icons.add),
            label: const Text('Add First Folder'),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF512BD4),
            ),
          ),
        ],
      ),
    );
  }

  void _toggleFolder(BuildContext context, String folderId, bool enabled) async {
    final folderRepository = context.read<FolderRepository>();
    final folder = await folderRepository.getByIdAsync(folderId);
    if (folder != null) {
      final updatedFolder = folder.copyWith(isEnabled: enabled);
      await folderRepository.updateAsync(updatedFolder);

      // Show feedback
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            folder.folderName + ' ' + (enabled ? 'enabled' : 'disabled'),
          ),
          backgroundColor: enabled ? Color(0xFF512BD4) : Colors.grey,
        ),
      );
    }
  }

  void _onFolderTap(BuildContext context, FolderConfig folder) {
    // Show folder details or scanning options
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Folder: ${folder.folderName}'),
        action: SnackBarAction(
          label: 'Scan',
          onPressed: () {
            // Trigger folder scan
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Scanning started')),
            );
          },
        ),
      ),
    );
  }
}