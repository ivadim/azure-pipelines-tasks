import fs = require('fs');
import os = require('os');
import path = require('path');
import taskLib = require('azure-pipelines-task-lib/task');
import toolLib = require('azure-pipelines-tool-lib/tool');

import { AzureStorageArtifactDownloader } from './AzureStorageArtifacts/AzureStorageArtifactDownloader';
import { JavaFilesExtractor, BIN_FOLDER } from './FileExtractor/JavaFilesExtractor';
import { sleepFor, buildFilePath, sudo, attach, detach } from './taskutils';

const supportedFileEndings = ['.tar', '.tar.gz', '.zip', '.7z', '.dmg', '.pkg'];
const VOLUMES_FOLDER = '/Volumes';
const JDK_FOLDER = '/Library/Java/JavaVirtualMachines';
const JDK_HOME_FOLDER = 'Contents/Home';
taskLib.setResourcePath(path.join(__dirname, 'task.json'));

async function run() {
    try {
        let versionSpec = taskLib.getInput('versionSpec', true);
        await getJava(versionSpec);
        taskLib.setResult(taskLib.TaskResult.Succeeded, taskLib.loc('SucceedMsg'));
    } catch (error) {
        taskLib.error(error.message);
        taskLib.setResult(taskLib.TaskResult.Failed, error.message);
    }
}

async function getJava(versionSpec: string) {
    const preInstalled: boolean = ('PreInstalled' === taskLib.getInput('jdkSourceOption', true));
    const fromAzure: boolean = ('AzureStorage' == taskLib.getInput('jdkSourceOption', true));
    const extractLocation: string = taskLib.getPathInput('jdkDestinationDirectory', true);
    const cleanDestinationDirectory: boolean = taskLib.getBoolInput('cleanDestinationDirectory', false);
    let compressedFileExtension: string;
    let jdkDirectory: string;
    const extendedJavaHome: string = `JAVA_HOME_${versionSpec}_${taskLib.getInput('jdkArchitectureOption', true)}`;

    toolLib.debug('Trying to get tool from local cache first');
    const localVersions: string[] = toolLib.findLocalToolVersions('Java');
    const version: string = toolLib.evaluateVersions(localVersions, versionSpec);

     // Clean the destination folder before downloading and extracting?
     if (cleanDestinationDirectory && taskLib.exist(extractLocation) && taskLib.stats(extractLocation).isDirectory) {
        console.log(taskLib.loc('CleanDestDir', extractLocation));

        // delete the contents of the destination directory but leave the directory in place
        fs.readdirSync(extractLocation)
        .forEach((item: string) => {
            const itemPath = path.join(extractLocation, item);
            taskLib.rmRF(itemPath);
        });
    }

    if (version) { //This version of Java JDK is already in the cache. Use it instead of downloading again.
        console.log(taskLib.loc('Info_ResolvedToolFromCache', version));
    } else if (preInstalled) {
        const preInstalledJavaDirectory: string | undefined = taskLib.getVariable(extendedJavaHome);
        if (!preInstalledJavaDirectory) {
            throw new Error(taskLib.loc('JavaNotPreinstalled', versionSpec));
        }
        console.log(taskLib.loc('UsePreinstalledJava', preInstalledJavaDirectory));
        jdkDirectory = preInstalledJavaDirectory;
    } else if (fromAzure) { //Download JDK from an Azure blob storage location and extract.
        console.log(taskLib.loc('RetrievingJdkFromAzure'));
        const fileNameAndPath: string = taskLib.getInput('azureCommonVirtualFile', false);

        const azureDownloader = new AzureStorageArtifactDownloader(taskLib.getInput('azureResourceManagerEndpoint', true),
            taskLib.getInput('azureStorageAccountName', true), taskLib.getInput('azureContainerName', true), "");
        await azureDownloader.downloadArtifacts(extractLocation, '*' + fileNameAndPath);
        await sleepFor(250); //Wait for the file to be released before extracting it.

        compressedFileExtension = getSupportedFileEnding(fileNameAndPath);
        const extractSource = buildFilePath(extractLocation, fileNameAndPath);
        jdkDirectory = await installJDK(extractSource, compressedFileExtension, extractLocation, extendedJavaHome, versionSpec);
    } else { //JDK is in a local directory. Extract to specified target directory.
        console.log(taskLib.loc('RetrievingJdkFromLocalPath'));
        const jdkFile: string = taskLib.getInput('jdkFile', true);
        compressedFileExtension = getSupportedFileEnding(jdkFile);
        jdkDirectory = await installJDK(jdkFile, compressedFileExtension, extractLocation, extendedJavaHome, versionSpec);
    }

    console.log(taskLib.loc('SetJavaHome', jdkDirectory));
    console.log(taskLib.loc('SetExtendedJavaHome', extendedJavaHome, jdkDirectory));
    taskLib.setVariable('JAVA_HOME', jdkDirectory);
    taskLib.setVariable(extendedJavaHome, jdkDirectory);
    toolLib.prependPath(path.join(jdkDirectory, BIN_FOLDER));
}

/**
 * Return file ending if it is supported. Otherwise throw an error.
 * @param file Path to a file.
 */
function getSupportedFileEnding(file: string): string {
    const fileEnding: string = supportedFileEndings.find(ending => file.endsWith(ending)); 

    if (fileEnding) {
        return fileEnding;
    } else {
        throw new Error(taskLib.loc('UnsupportedFileExtension'));
    }
}

/**
 * Install JDK.
 * @param sourceFile Path to JDK file.
 * @param fileExtension JDK file extension.
 * @param archiveExtractLocation Path to folder to extract a JDK.
 */
async function installJDK(sourceFile: string, fileExtension: string, archiveExtractLocation: string, extendedJavaHome: string, versionSpec: string): Promise<string> {
    let jdkDirectory;
    if (fileExtension === '.dmg' && os.platform() === 'darwin') {
        // Using set because 'includes' array method requires tsconfig option "lib": ["ES2017"]
        const volumes: Set<string> = new Set(fs.readdirSync(VOLUMES_FOLDER));

        await attach(sourceFile);
    
        const volumePath: string = getVolumePath(volumes);

        let pkgPath: string = getPackagePath(volumePath);
        try {
            jdkDirectory = await installPkg(pkgPath, extendedJavaHome, versionSpec);
        } catch (error) {
            // In case of an error, there is still a need to detach the disk image
            await detach(volumePath);
            throw error;
        }

        await detach(volumePath);
    }
    else if (fileExtension === '.pkg' && os.platform() === 'darwin') {
        jdkDirectory = await installPkg(sourceFile, extendedJavaHome, versionSpec);
    }
    else {
        const javaFilesExtractor = new JavaFilesExtractor();
        jdkDirectory = await javaFilesExtractor.unzipJavaDownload(sourceFile, fileExtension, archiveExtractLocation);
    }
    return jdkDirectory;
}

/**
 * Get the path to a folder inside the VOLUMES_FOLDER.
 * Only for macOS.
 * @param volumes VOLUMES_FOLDER contents before attaching a disk image.
 */
function getVolumePath(volumes: Set<string>): string {
    const newVolumes: string[] = fs.readdirSync(VOLUMES_FOLDER).filter(volume => !volumes.has(volume));

    if (newVolumes.length !== 1) {
        throw new Error(taskLib.loc('UnsupportedDMGStructure'));
    }
    return path.join(VOLUMES_FOLDER, newVolumes[0]);
}

/**
 * Get path to a .pkg file.
 * Only for macOS.
 * @param volumePath Path to the folder containing a .pkg file.
 */
function getPackagePath(volumePath: string): string {
    const packages: string[] = fs.readdirSync(volumePath).filter(file => file.endsWith('.pkg'));

    if (packages.length === 1) {
        return path.join(volumePath, packages[0]);
    } else if (packages.length === 0) {
        throw new Error(taskLib.loc('NoPKGFile'));
    } else {
        throw new Error(taskLib.loc('SeveralPKGFiles'));
    }
}

async function installPkg(pkgPath: string, extendedJavaHome: string, versionSpec: string): Promise<string> {
    if (!fs.existsSync(pkgPath)) {
        throw new Error('PkgPathDoesNotExist');
    }

    console.log(taskLib.loc('InstallJDK'));

    // Using set because 'includes' array method requires tsconfig option "lib": ["ES2017"]
    const JDKs: Set<string> = new Set(fs.readdirSync(JDK_FOLDER));

    await runPkgInstaller(pkgPath);

    const newJDKs = fs.readdirSync(JDK_FOLDER).filter(jdkName => !JDKs.has(jdkName));

    let jdkDirectory: string;

    if (newJDKs.length === 0) {
        const preInstalledJavaDirectory: string | undefined = taskLib.getVariable(extendedJavaHome);
        if (!preInstalledJavaDirectory) {
            throw new Error(taskLib.loc('JavaNotPreinstalled', versionSpec));
        }
        console.log(taskLib.loc('PreInstalledJavaUpgraded'));
        console.log(taskLib.loc('UsePreinstalledJava', preInstalledJavaDirectory));
        jdkDirectory = preInstalledJavaDirectory;
    } else {
        console.log(taskLib.loc('JavaSuccessfullyInstalled'));
        jdkDirectory = path.join(JDK_FOLDER, newJDKs[0], JDK_HOME_FOLDER);
    }

    return jdkDirectory;
}

/**
 * Install a .pkg file.
 * Only for macOS.
 * @param pkgPath Path to a .pkg file.
 */
async function runPkgInstaller(pkgPath: string): Promise<void> {
    const installer = sudo('installer');
    installer.line(`-package "${pkgPath}" -target /`);
    await installer.exec();
}

run();
