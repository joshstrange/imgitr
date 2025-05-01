import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import GIF from 'sharp-gif2';
import {Command} from 'commander';

/**
 * ImgItr - Image Iteration Tool
 *
 * This script provides two main functionalities:
 * 1. Generate Mode: Takes an input image and iteratively processes it through OpenAI's Image GPT,
 *    creating a sequence of images that evolve from the original. It then compiles these images into an animated GIF.
 * 2. GIF Creation Mode: Takes a directory of existing PNG images and compiles them into an animated GIF.
 *
 * The tool ensures proper handling of image dimensions, alpha channels, and maintains a consistent
 * output structure in the 'generated' directory.
 *
 * Usage:
 *   - Generate Mode: bun src/index.ts generate <input_image_path> <iterations>
 *   - GIF Creation Mode: bun src/index.ts gif <directory_path>
 */

// --- Configuration & Setup ---
const baseOutputDir = 'generated';

// --- OpenAI Client ---
let openai: OpenAI | null = null;

// --- CLI Setup with Commander ---
const program = new Command();

program
	.name('imgitr')
	.description('Iterate over an image using OpenAI Image GPT')
	.version('1.0.0');

program
	.command('generate')
	.description(
		'Generate a sequence of images by iterating through OpenAI Image GPT',
	)
	.argument('<input_image_path>', 'path to the input image')
	.argument('<iterations>', 'number of iterations to perform', parseInt)
	.option('--prompt <prompt>', 'custom prompt to use for image generation', "Create the exact replica of this image, don't change a thing.")
	.option('--delay <delay>', 'delay between frames in milliseconds for the generated GIF', (val) => parseInt(val), 500)
	.action(async (inputPath, iterations, options) => {
		if (isNaN(iterations) || iterations <= 0) {
			console.error('Error: Iterations must be a positive number');
			process.exit(1);
		}

		// Ensure the base output directory exists
		await fs.mkdir(baseOutputDir, {recursive: true});

		try {
			// Validate input path exists
			const stats = await fs.stat(inputPath);

			if (!stats.isFile()) {
				throw new Error(
					`Input path "${inputPath}" must be a file for generate mode.`,
				);
			}

			console.log(
				`Mode: Generate ${iterations} images starting from ${inputPath}`,
			);
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				'code' in err &&
				err.code === 'ENOENT'
			) {
				console.error(`Error: Input path "${inputPath}" not found.`);
				process.exit(1);
			} else {
				throw err;
			}
		}

		// Initialize the OpenAI client
		if (!process.env.OPENAI_API_KEY) {
			console.error(
				'Error: OPENAI_API_KEY environment variable not set (required for generate mode).',
			);
			process.exit(1);
		}
		openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

		await runImageGeneration(inputPath, iterations, options.prompt, options.delay);
	});

program
	.command('gif')
	.description('Create a GIF from a directory of PNG images')
	.argument('<directory_path>', 'path to the directory containing PNG images')
	.option('--delay <delay>', 'delay between frames in milliseconds', (val) => parseInt(val), 500)
	.action(async (dirPath, options) => {
		// Ensure the base output directory exists
		await fs.mkdir(baseOutputDir, {recursive: true});

		try {
			// Validate input path exists
			const stats = await fs.stat(dirPath);

			if (!stats.isDirectory()) {
				throw new Error(
					`Input path "${dirPath}" must be a directory for gif mode.`,
				);
			}

			console.log(`Mode: Create GIF from directory ${dirPath}`);
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				'code' in err &&
				err.code === 'ENOENT'
			) {
				console.error(`Error: Input path "${dirPath}" not found.`);
				process.exit(1);
			} else {
				throw err;
			}
		}

		await runGifCreationFromDirectory(dirPath, options.delay);
	});

// --- Function Implementations ---

// --- Function for Image Generation Mode ---
/**
 * Runs the image generation process using OpenAI's Image GPT.
 * Takes an input image, iteratively processes it through OpenAI, and creates a sequence of evolved images.
 * Finally, compiles these images into an animated GIF.
 *
 * @param inputImagePath - Path to the input image to start the generation from
 * @param numIterations - Number of iterations to perform
 * @param prompt - Custom prompt to use for image generation
 * @param delayMs - Delay between frames in milliseconds for the generated GIF
 */
async function runImageGeneration(
	inputImagePath: string,
	numIterations: number,
	prompt: string,
	delayMs: number,
) {
	if (!openai) {
		// Type guard
		throw new Error('OpenAI client not initialized for generation mode.');
	}
	// Create the output directory name (date-time and a random string) for this run
	const now = new Date();
	const dateStr =
		now.getFullYear().toString() +
		(now.getMonth() + 1).toString().padStart(2, '0') +
		now.getDate().toString().padStart(2, '0') +
		'-' +
		now.getHours().toString().padStart(2, '0') +
		now.getMinutes().toString().padStart(2, '0') +
		now.getSeconds().toString().padStart(2, '0');
	const randomStr = Math.random().toString(36).substring(2, 8);
	const outputFolderName = `${dateStr}-${randomStr}`;
	const outputFolderPath = path.join(baseOutputDir, outputFolderName);
	await fs.mkdir(outputFolderPath, {recursive: true});
	console.log(`Outputting generated files to: ${outputFolderPath}`);

	// --- Load input image and validate ---
	const inputImageMetadata = await sharp(inputImagePath).metadata();
	const width = inputImageMetadata.width;
	const height = inputImageMetadata.height;

	if (!width || !height) {
		throw new Error('Could not read input image dimensions.');
	}
	if (width !== height) {
		throw new Error('Input image must be square.');
	}
	if (width > 1024 || height > 1024) {
		throw new Error('Input image dimensions must be <= 1024x1024.');
	}
	// Choose the closest allowed size for output (>= input size)
	let sizeParam: '256x256' | '512x512' | '1024x1024';
	if (width <= 256) {
		sizeParam = '256x256';
	} else if (width <= 512) {
		sizeParam = '512x512';
	} else {
		sizeParam = '1024x1024';
	}

	// --- Prepare for iterations ---
	const paddingLength = numIterations.toString().length; // Use numIterations passed to function
	const firstFrameFilename = `${String(0).padStart(paddingLength, '0')}.png`;
	const firstFramePath = path.join(outputFolderPath, firstFrameFilename);

	// Process and save the input image as the first frame (frame 0), ensuring the alpha channel exists
	await sharp(inputImagePath)
		.ensureAlpha() // Add the alpha channel if missing
		.png() // Ensure output is PNG
		.toFile(firstFramePath);
	console.log(
		`Processed input image and saved to ${firstFramePath} as the starting frame.`,
	);

	// Initialize the array and current image path with the processed first frame
	const generatedFrames: string[] = [firstFramePath];
	let currentImagePath = firstFramePath;

	// --- Iterate and generate images ---
	for (let i = 1; i <= numIterations; i++) {
		// Use numIterations
		console.log(`Starting iteration ${i} with image: ${currentImagePath}`);

		// Read the current image with sharp, ensure alpha, and get PNG buffer
		const imageBuffer = await sharp(currentImagePath)
			.ensureAlpha()
			.png()
			.toBuffer();

		// Create a File-like object for the image buffer
		const imageFile = new File([imageBuffer], 'image.png', {
			type: 'image/png',
		});

		// Use openai.images.edit (v4 style)
		const response = await openai.images.edit({
			model: 'gpt-image-1',
			image: imageFile,
			prompt: prompt,
			n: 1,
			size: sizeParam,
		});

		if (!response || !response.data || response.data.length === 0) {
			throw new Error(`No image data received for iteration ${i}`);
		}

		const b64Image = response.data[0].b64_json;
		if (!b64Image) {
			throw new Error(`No base64 image data received for iteration ${i}`);
		}
		const imageData = Buffer.from(b64Image, 'base64');
		// Use the determined padding length for the later frames as well
		const fileName = `${String(i).padStart(paddingLength, '0')}.png`;
		const outputPath = path.join(outputFolderPath, fileName);
		await fs.writeFile(outputPath, imageData);
		generatedFrames.push(outputPath);
		currentImagePath = outputPath;
		console.log(`Saved iteration ${i} to ${outputPath}`);
	}

	// --- Create a GIF from the generated frames ---
	if (generatedFrames.length > 0) {
		const gifPath = path.join(outputFolderPath, `animation.gif`); // Save GIF inside the run folder
		await createGif(generatedFrames, gifPath, delayMs);
	} else {
		console.log('No frames were generated.');
	}
}

// --- Function for GIF Creation from Directory Mode ---
/**
 * Creates an animated GIF from a directory of PNG images.
 * Reads all PNG files from the specified directory, sorts them alphabetically,
 * and compiles them into an animated GIF.
 *
 * @param dirPath - Path to the directory containing PNG images to be used as frames
 * @param delayMs - Delay between frames in milliseconds for the generated GIF
 */
async function runGifCreationFromDirectory(dirPath: string, delayMs: number) {
	console.log(`Reading frames from directory: ${dirPath}`);
	let framePaths: string[];
	try {
		const files = await fs.readdir(dirPath);
		framePaths = files
			.filter((file) => file.toLowerCase().endsWith('.png')) // Filter for PNG files
			.map((file) => path.join(dirPath, file)) // Get full paths
			.sort(); // Sort alphabetically/numerically
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		console.error(`Error reading directory ${dirPath}: ${errorMessage}`);
		process.exit(1);
	}

	if (framePaths.length === 0) {
		console.error(
			`No .png files found in directory ${dirPath}. Cannot create GIF.`,
		);
		process.exit(1);
	}

	console.log(`Found ${framePaths.length} frames.`);

	// Determine the output GIF path (place it in the 'generated' dir with name based on source dir)
	const dirName = path.basename(dirPath);
	const outputGifPath = path.join(baseOutputDir, `${dirName}.gif`);

	// Create a GIF from the found frames
	await createGif(framePaths, outputGifPath, delayMs);
}

/**
 * Creates an animated GIF from a list of frame image paths.
 * @param framePaths Array of paths to the frame images.
 * @param outputGifPath Path where the generated GIF will be saved.
 * @param delayMs Delay between frames in milliseconds.
 */
async function createGif(
	framePaths: string[],
	outputGifPath: string,
	delayMs: number,
) {
	if (framePaths.length === 0) {
		console.warn('No frames provided to create GIF.');
		return;
	}
	console.log(
		`Creating GIF from ${framePaths.length} frames using sharp-gif2...`,
	);
	try {
		// Create sharp instances for each frame path
		const sharpFrames = framePaths.map((framePath) => sharp(framePath));

		// Use sharp-gif2 to create the GIF
		const gifInstance = GIF.createGif({
			delay: delayMs, // Set delay for all frames
			repeat: 0, // Loop forever
		});

		gifInstance.addFrame(sharpFrames); // Add all sharp frame instances

		// Generate the GIF buffer
		const gifBuffer = await gifInstance.toBuffer((/*info*/) => {
			// Optional progress tracking
			// console.log(`Encoding GIF: ${info.encoded}/${info.total}`);
		});

		// Write the buffer to the output file
		await fs.writeFile(outputGifPath, gifBuffer);

		console.log(`Animated GIF saved to ${outputGifPath}`);
	} catch (error: unknown) {
		console.error('Error creating GIF with sharp-gif2:', error);
		throw error; // Re-throw to be caught by the main handler
	}
}

// Parse command line arguments and execute the appropriate command
program.parse(process.argv);

// Add a global error handler for any uncaught errors
process.on('unhandledRejection', (err: unknown) => {
	const errorMessage = err instanceof Error ? err.message : String(err);
	console.error('Unhandled error:', errorMessage);
	process.exit(1);
});
