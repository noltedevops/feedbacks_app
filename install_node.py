import urllib.request
import zipfile
import os
import sys

NODE_URL = "https://nodejs.org/dist/v22.13.0/node-v22.13.0-win-x64.zip"
TARGET_DIR = r"c:\Apps\feedbackapp\node"
ZIP_PATH = os.path.join(TARGET_DIR, "node.zip")

def main():
    print(f"Ensuring target directory exists: {TARGET_DIR}")
    os.makedirs(TARGET_DIR, exist_ok=True)
    
    node_exe = os.path.join(TARGET_DIR, "node-v22.13.0-win-x64", "node.exe")
    if os.path.exists(node_exe):
        print(f"Node.js already exists at {node_exe}")
        return
        
    print(f"Downloading Node.js from {NODE_URL}...")
    try:
        def reporthook(blocknum, blocksize, totalsize):
            readsofar = blocknum * blocksize
            if totalsize > 0:
                percent = readsofar * 1e2 / totalsize
                s = f"\rDownloading: {percent:.1f}% ({readsofar / 1e6:.1f} MB / {totalsize / 1e6:.1f} MB)"
                sys.stdout.write(s)
                sys.stdout.flush()
            else:
                sys.stdout.write(f"\rDownloading: {readsofar / 1e6:.1f} MB")
                sys.stdout.flush()
                
        urllib.request.urlretrieve(NODE_URL, ZIP_PATH, reporthook)
        print("\nDownload completed. Extracting zip...")
        
        with zipfile.ZipFile(ZIP_PATH, 'r') as zip_ref:
            zip_ref.extractall(TARGET_DIR)
            
        print("Extraction complete. Cleaning up zip file...")
        os.remove(ZIP_PATH)
        
        if os.path.exists(node_exe):
            print(f"Node.js successfully installed at: {node_exe}")
        else:
            print("Warning: node.exe not found at expected path after extraction.")
            
    except Exception as e:
        print(f"Error occurred: {e}")
        if os.path.exists(ZIP_PATH):
            os.remove(ZIP_PATH)
        sys.exit(1)

if __name__ == "__main__":
    main()
