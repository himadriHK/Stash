## Stash is a self hosted backup tool. It consists of two applications, the StashHost and Stash(the mobile application).

## How it works:
The mobile application scans and keeps uploading files from phone storage to storage provider. 
For each upload it records the file_id and other metadata and sends a message via kafka that says it has uploaded a file.
The file is marked as uploaded only when the mobile application receives a response via kafka.

The host application is hooked to the kafka and checks for every new message. Once a message is received from the mobile application that says a new file has been uploaded, the application starts an orchestration of multiple tasks that involves downloading, compression, conversion, creating thumbnails, saving the file on disk, deleting the file in storage provider. and finally sending a response to the mobile application via kafka.

## StashHost
This is a durable azure function application that checks for new messages on kafka for any new file uploaded.
On receiving a file uploaded message from kafka, the application starts an orchestration of multiple tasks that involves downloading, compression, conversion, creating thumbnails, saving the file on disk and finally sending a response to the mobile application via kafka.

## Stash
This is the main application that the user will be working with. This is a MAUI mobile app. 
This has an interface very similar to Google Photos. When the application opens up, the user gets a screen to configure the folders to scan for backup. Once thats done, the app shows all the files in the selected folders as thumbnails. The app shows notifications for any backup job in progress.
Currently the application will just support backup, later on additional functionalities will be introduced.
The application uploads files in batches. The application will use local db to keep track of uploaded files.
The application will talk to kafka and the storage provider, and wont talk directly to StashHost.

### Storage Provider
This is an abstraction to support multiple storage providers.

#### Mega IO Storage Provider
This is an implementation of Storage Provider for mega.io. Refer to https://gpailler.github.io/MegaApiClient/index.html for documentation.

### Kafka Cluster Provider
This is an abstraction to support multiple kafka cluster providers.

#### Aiven
This is an implementation of Kafka Cluster Provider. Refer to https://aiven.io/docs/products/kafka for documentation.