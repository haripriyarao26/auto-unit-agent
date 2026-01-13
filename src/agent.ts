import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Load .env file from src directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  envContent.split("\n").forEach((line) => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith("#")) {
      const [key, ...valueParts] = trimmedLine.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
        process.env[key.trim()] = value;
      }
    }
  });
}

/**
 * State interface for the agent workflow
 */
interface AgentState {
  sourceCode: string;
  testCode: string;
  errors: string[];
  iterations: number;
  filePath: string;
}

/**
 * Create the state annotation using LangGraph's Annotation.Root
 */
const AgentStateAnnotation = Annotation.Root({
  sourceCode: Annotation<string>(),
  testCode: Annotation<string>(),
  errors: Annotation<string[]>(),
  iterations: Annotation<number>(),
  filePath: Annotation<string>(),
});

/**
 * Get OpenAI API key
 */
function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }
  return key;
}

/**
 * Parse AI response to extract code
 */
function parseAIResponse(text: string): string | null {
  if (!text || text.trim().length === 0) {
    return null;
  }
  
  // Try multiple extraction patterns
  const patterns = [
    /```typescript\s*\n([\s\S]*?)```/,
    /```ts\s*\n([\s\S]*?)```/,
    /```\s*\n([\s\S]*?)```/,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  // If no code blocks, check if it's raw code
  if (text.includes("import") || text.includes("describe") || text.includes("it(")) {
    return text.trim();
  }
  
  return null;
}

/**
 * Call OpenAI API
 */
async function callOpenAI(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini", // Using cheaper model, can switch to gpt-4o if needed
      messages: [
        {
          role: "system",
          content: "You are an expert TypeScript/Jest test writer. Always output test code wrapped in ```typescript code blocks. Never include explanations outside the code block."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 2048,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const data: any = await response.json();
  
  if (!data.choices || data.choices.length === 0) {
    throw new Error("OpenAI returned no choices");
  }

  return data.choices[0].message?.content || "";
}

async function generateTest(state: AgentState): Promise<Partial<AgentState>> {
  console.log(`\n[Generate Test] Iteration ${state.iterations + 1}`);
  const apiKey = getOpenAIKey();

  // Extract filename for import
  const sourceFileName = path.basename(state.filePath, path.extname(state.filePath));
  
  // Extract exported function names from source code
  const exportMatches = state.sourceCode.match(/export\s+(?:function|const|async\s+function)\s+(\w+)/g);
  const functionNames = exportMatches 
    ? exportMatches.map(m => m.match(/(\w+)\s*[=(]/)?.[1]).filter(Boolean)
    : [];

  const prompt = state.iterations === 0
    ? `Generate comprehensive Jest unit tests for this TypeScript function:

\`\`\`typescript
${state.sourceCode}
\`\`\`

IMPORTANT REQUIREMENTS:
1. Start with: /// <reference types="jest" />
2. Use ESM import: import { ${functionNames.join(', ')} } from './${sourceFileName}.js';
   - The source file is named: ${sourceFileName}.ts
   - You MUST use './${sourceFileName}.js' (with .js extension for ESM)
3. Test normal cases
4. Test edge cases (empty arrays, boundary values, etc.)
5. Test error cases if applicable using expect(() => function()).toThrow('error message')
6. Use describe() and it() blocks
7. Output ONLY the test code in a typescript code block, no explanations`
    : `Fix the test code. Previous errors:
${state.errors.slice(0, 10).join('\n')}

Previous test code:
\`\`\`typescript
${state.testCode.substring(0, 1000)}
\`\`\`

Original function:
\`\`\`typescript
${state.sourceCode}
\`\`\`

IMPORTANT: The source file is named ${sourceFileName}.ts
You MUST use: import { ${functionNames.join(', ')} } from './${sourceFileName}.js';

Generate the corrected test code in a typescript code block.`;

  try {
    console.log("  Calling OpenAI API...");
    const generatedText = await callOpenAI(prompt, apiKey);
    
    if (!generatedText || generatedText.trim().length === 0) {
      console.error("❌ Empty response from OpenAI");
      return {
        errors: ["OpenAI returned empty response"],
        iterations: state.iterations + 1,
      };
    }

    console.log(`  Raw response length: ${generatedText.length} chars`);
    
    // Extract code from response
    const parsed = parseAIResponse(generatedText);
    
    if (!parsed || parsed.length < 50) {
      console.error("❌ Extracted code is too short or empty");
      console.log(`  Extracted length: ${parsed?.length || 0}`);
      console.log(`  First 500 chars of raw response:\n${generatedText.substring(0, 500)}`);
      return {
        errors: [`Generated code is too short (${parsed?.length || 0} chars). Raw response: ${generatedText.substring(0, 200)}`],
        iterations: state.iterations + 1,
      };
    }

    // Validate extracted code
    const hasDescribe = parsed.includes("describe");
    const hasIt = parsed.includes("it(") || parsed.includes("test(");
    const hasImport = parsed.includes("import");
    
    console.log(`✓ Test code extracted: ${parsed.length} chars`);
    console.log(`  Has describe: ${hasDescribe}, Has it/test: ${hasIt}, Has import: ${hasImport}`);
    
    if (!hasDescribe && !hasIt) {
      console.warn("⚠️ Code doesn't contain describe/it blocks");
      console.log(`  First 300 chars:\n${parsed.substring(0, 300)}`);
    }
    
    return {
      testCode: parsed,
      iterations: state.iterations + 1,
    };
  } catch (error: any) {
    console.error("❌ OpenAI API Error:", error.message);
    if (error.stack) {
      console.error("Stack:", error.stack.substring(0, 500));
    }
    return {
      errors: [`OpenAI API failed: ${error.message}`],
      iterations: state.iterations + 1,
    };
  }
}


/**
 * Execute test in virtual sandbox
 */
function executeTest(state: AgentState): Partial<AgentState> {
  console.log(`\n[Execute Test] Running tests in sandbox...`);
  
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-test-agent-"));
  
  try {
    // Validate test code BEFORE creating files
    if (!state.testCode || state.testCode.trim().length === 0) {
      const errorMsg = "Test code is empty! Cannot write test file.";
      console.error(`  ❌ ${errorMsg}`);
      return {
        errors: [errorMsg],
      };
    }
    
    // Additional validation
    if (state.testCode.trim().length < 50) {
      const errorMsg = `Test code is too short (${state.testCode.length} chars). Minimum 50 required.`;
      console.error(`  ❌ ${errorMsg}`);
      return {
        errors: [errorMsg],
      };
    }
    
    // Extract function name and file name from source file path
    const sourceFileName = path.basename(state.filePath, path.extname(state.filePath));
    const sourceFileExt = path.extname(state.filePath);
    
    // Create the source file in temp directory
    const sourceFilePath = path.join(tmpDir, `${sourceFileName}${sourceFileExt}`);
    fs.writeFileSync(sourceFilePath, state.sourceCode, "utf-8");
    
    // Create the test file with matching name
    const testFilePath = path.join(tmpDir, `${sourceFileName}.test${sourceFileExt}`);
    
    // Ensure test code has Jest types reference
    let testCodeWithTypes = state.testCode;
    if (!testCodeWithTypes.includes('/// <reference types="jest" />')) {
      testCodeWithTypes = '/// <reference types="jest" />\n' + testCodeWithTypes;
    }
    
    fs.writeFileSync(testFilePath, testCodeWithTypes, "utf-8");
    
    // Verify file was written correctly
    const writtenContent = fs.readFileSync(testFilePath, "utf-8");
    if (writtenContent.trim().length === 0) {
      throw new Error("Test file was written but is empty after read!");
    }
    
    console.log(`  ✓ Test file written: ${testFilePath}`);
    console.log(`  ✓ File size: ${writtenContent.length} characters`);
    console.log(`  ✓ Preview (first 200 chars):\n${writtenContent.substring(0, 200)}...`);
    
    // Get project root first (needed for jest config)
    const projectRoot = process.cwd();
    
    // Create package.json for the temp project
    const packageJson = {
      name: "temp-test",
      type: "module",
      scripts: {
        test: "jest",
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify(packageJson, null, 2),
      "utf-8"
    );
    
    // Create jest.config.js with explicit paths to project node_modules
    const jestConfig = `export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        types: ['jest', 'node'],
      },
    }],
  },
  moduleDirectories: ['node_modules', '${path.join(projectRoot, "node_modules").replace(/\\/g, "/")}'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};`;
    fs.writeFileSync(path.join(tmpDir, "jest.config.js"), jestConfig, "utf-8");
    
    // Create tsconfig.json with Jest types
    const tsConfig = {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "node",
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["jest", "node"],
        typeRoots: [path.join(projectRoot, "node_modules", "@types")],
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify(tsConfig, null, 2),
      "utf-8"
    );
    
    // Create a jest setup file to ensure types are loaded
    const jestSetupContent = `/// <reference types="jest" />\n`;
    fs.writeFileSync(path.join(tmpDir, "jest.setup.ts"), jestSetupContent, "utf-8");
    
    // Run Jest tests using project's jest installation
    const jestPath = path.join(projectRoot, "node_modules", ".bin", "jest");
    
    // Verify jest exists
    if (!fs.existsSync(jestPath)) {
      throw new Error(`Jest not found at ${jestPath}. Please run 'npm install' first.`);
    }
    
    let output: string = "";
    let errorOutput: string = "";
    try {
      // Use execSync with proper working directory and shell
      output = execSync(`${jestPath} --no-coverage 2>&1`, {
        cwd: tmpDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 30000, // 30 second timeout
        env: {
          ...process.env,
          NODE_PATH: path.join(projectRoot, "node_modules"),
        },
        shell: "/bin/sh",
      });
    } catch (error: any) {
      // Jest exits with non-zero on failure, but we want the output
      output = error.stdout || "";
      errorOutput = error.stderr || "";
      if (!output && !errorOutput) {
        output = error.message || String(error);
      }
    }
    
    // Combine stdout and stderr
    const fullOutput = output + (errorOutput ? "\n" + errorOutput : "");
    
    // Check if tests passed (Jest exits with 0 on success)
    const testPassed = !fullOutput.includes("FAIL") && (fullOutput.includes("PASS") || fullOutput.includes("Tests:"));
    
    if (testPassed) {
      console.log("✓ All tests passed!");
      return { errors: [] };
    } else {
      // Extract comprehensive error information
      const lines = fullOutput.split("\n");
      const errorLines: string[] = [];
      let inErrorBlock = false;
      let errorBlock: string[] = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isErrorLine = 
          line.includes("FAIL") || 
          line.includes("Error:") || 
          line.includes("TypeError") ||
          line.includes("ReferenceError") ||
          line.includes("SyntaxError") ||
          line.includes("Cannot find module") ||
          line.includes("Expected") ||
          line.includes("Received") ||
          line.includes("●") ||
          (line.trim().startsWith("at ") && inErrorBlock);
        
        if (isErrorLine) {
          inErrorBlock = true;
          errorBlock.push(line);
        } else if (inErrorBlock && (line.trim() === "" || line.includes("Test Suites:") || line.includes("Tests:"))) {
          // End of error block
          if (errorBlock.length > 0) {
            errorLines.push(...errorBlock);
            errorBlock = [];
          }
          inErrorBlock = false;
        } else if (inErrorBlock) {
          errorBlock.push(line);
        }
      }
      
      // Add any remaining error block
      if (errorBlock.length > 0) {
        errorLines.push(...errorBlock);
      }
      
      // If we didn't capture enough, include more context
      if (errorLines.length === 0 || errorLines.length < 3) {
        // Get the last 50 lines which usually contain the error
        const relevantLines = lines.slice(-50).filter(line => line.trim().length > 0);
        errorLines.push(...relevantLines);
      }
      
      // Limit error size but keep important parts
      const maxErrorLines = 30;
      const finalErrors = errorLines.length > maxErrorLines 
        ? [...errorLines.slice(0, maxErrorLines), `... (${errorLines.length - maxErrorLines} more lines)`]
        : errorLines;
      
      console.log("✗ Tests failed");
      console.log("Full error output (last 20 lines):");
      lines.slice(-20).forEach(line => console.log(`  ${line}`));
      
      return {
        errors: finalErrors.length > 0 ? finalErrors : [fullOutput.substring(0, 1000)],
      };
    }
  } catch (error: any) {
    console.error("Error executing tests:", error.message);
    const errorMessage = error.stdout || error.stderr || error.message || String(error);
    return {
      errors: [`Test execution failed: ${errorMessage}`],
    };
  } finally {
    // Cleanup: remove temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn("Warning: Failed to cleanup temp directory:", cleanupError);
    }
  }
}

/**
 * Debug test (currently just passes through, but can be extended)
 */
function debugTest(state: AgentState): Partial<AgentState> {
  console.log(`\n[Debug Test] Analyzing errors...`);
  console.log(`Errors found: ${state.errors.length}`);
  state.errors.forEach((error, idx) => {
    console.log(`  ${idx + 1}. ${error.substring(0, 100)}...`);
  });
  return {};
}

/**
 * Conditional edge function: decide next step based on state
 */
function shouldContinue(state: AgentState): string {
  if (state.errors.length === 0) {
    return "end";
  }
  if (state.iterations < 3) {
    return "generate_test";
  }
  return "end";
}

/**
 * Main agent execution
 */
async function runAgent(sourceFilePath: string): Promise<void> {
  console.log("🚀 Automated Unit-Testing Agent");
  console.log("=" .repeat(50));
  
  // Read source code
  if (!fs.existsSync(sourceFilePath)) {
    throw new Error(`Source file not found: ${sourceFilePath}`);
  }
  
  const sourceCode = fs.readFileSync(sourceFilePath, "utf-8");
  
  // Initialize state
  const initialState: AgentState = {
    sourceCode,
    testCode: "",
    errors: [],
    iterations: 0,
    filePath: sourceFilePath,
  };
  
  // Create the state graph
  const workflow = new StateGraph(AgentStateAnnotation)
    .addNode("generate_test", generateTest)
    .addNode("execute_test", executeTest)
    .addNode("debug_test", debugTest)
    .addEdge(START, "generate_test")
    .addEdge("generate_test", "execute_test")
    .addEdge("execute_test", "debug_test")
    .addConditionalEdges(
      "debug_test",
      shouldContinue,
      {
        generate_test: "generate_test",
        end: END,
      }
    );
  
  // Compile the graph
  const app = workflow.compile();
  
  // Run the agent
  try {
    const finalState = await app.invoke(initialState);
    
    console.log("\n" + "=".repeat(50));
    if (finalState.errors.length === 0) {
      console.log("✅ SUCCESS: All tests passed!");
      console.log("\nGenerated Test Code:");
      console.log("-".repeat(50));
      console.log(finalState.testCode);
    } else {
      console.log("❌ FAILED: Could not generate passing tests after 3 iterations");
      console.log("\nFinal Errors:");
      finalState.errors.forEach((error: string, idx: number) => {
        console.log(`${idx + 1}. ${error}`);
      });
    }
  } catch (error) {
    console.error("\n❌ Agent execution failed:", error);
    throw error;
  }
}

// Main execution
// Usage: npm start src/leetcode_binary.ts
// Or: npm start src/leetcode_dp.ts
const sourceFile = process.argv[2];
if (!sourceFile) {
  console.error("❌ Error: Please provide a source file path");
  console.error("Usage: npm start src/yourFile.ts");
  process.exit(1);
}
runAgent(sourceFile).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

