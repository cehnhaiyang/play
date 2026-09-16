import { downloadArtifact } from '@electron/get';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

async function customInstall() {
  const __dirname = path.join(process.cwd(), 'node_modules', 'electron');
  const electronPkgPath = path.join(__dirname, 'package.json');
  let version;
  if (fs.existsSync(electronPkgPath)) {
    version = JSON.parse(fs.readFileSync(electronPkgPath, 'utf-8')).version;
  } else {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    const rawVersion = pkg.devDependencies?.electron || pkg.dependencies?.electron || '43.1.1';
    version = rawVersion.replace(/^[^\d]+/, '');
  }

  const checksumsFile = path.join(__dirname, 'checksums.json');
  const checksums = fs.existsSync(checksumsFile) ? JSON.parse(fs.readFileSync(checksumsFile, 'utf-8')) : undefined;

  try {
    console.log(`Downloading artifact v${version} via @electron/get...`);
    // Must set env var for electron-get to pick up
    process.env.ELECTRON_MIRROR = "https://cdn.npmmirror.com/binaries/electron/";
    
    const zipPath = await downloadArtifact({
      version,
      artifactName: 'electron',
      force: false,
      checksums
    });
    console.log("Download success, zip path:", zipPath);
    
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    
    console.log("Extracting zip using PowerShell Expand-Archive...");
    execSync(`powershell -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${distDir}' -Force"`, { stdio: 'inherit' });
    
    console.log("Extraction complete!");
    
    const srcTypeDefPath = path.join(distDir, 'electron.d.ts');
    const targetTypeDefPath = path.join(__dirname, 'electron.d.ts');
    if (fs.existsSync(srcTypeDefPath)) {
      fs.renameSync(srcTypeDefPath, targetTypeDefPath);
    }
    
    fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');
    console.log("path.txt written successfully.");
    
    console.log("dist/electron.exe exists?", fs.existsSync(path.join(distDir, 'electron.exe')));
  } catch (err) {
    console.error("Error during custom install:", err);
  }
}
customInstall();
