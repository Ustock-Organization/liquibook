const esbuild = require('esbuild');

console.log('🚀 Building optimized Lambda bundle...');

esbuild.build({
  entryPoints: ['index.mjs'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20', // Node.js 20 Lambda execution environment
  outfile: 'dist/index.js',
  // external: ['@aws-sdk/*', 'aws-sdk'], // COMMENTED OUT: Bundle everything to prevent runtime version mismatches.
  // Bundling AWS SDK v3 is safer and ensures 'NodeHttpHandler' compatibility.
  
  sourcemap: false,
  treeShaking: true,
}).then(() => {
  console.log('✅ Build complete! Output: dist/index.js');
  console.log('👇 Next steps:');
  console.log('1. cd dist');
  console.log('2. zip -r function.zip index.js');
  console.log('3. aws lambda update-function-code --function-name Supernoba-order-router --zip-file fileb://function.zip');
}).catch(() => process.exit(1));
