import { TaskDefinition } from '../types/index.js';
import { TaskRouter } from '../router/TaskRouter.js';
import { ResultMerger } from '../merger/ResultMerger.js';
import { GenerationMerger } from '../merger/GenerationMerger.js';
import { config } from '../config/index.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any, router: TaskRouter) => Promise<string>;
}

const GENERATION_COMMON_PROPERTIES = {
  language: { type: 'string', description: 'Target programming language (e.g. typescript, csharp, python)' },
  architecture: { type: 'string', description: 'Architecture to follow (e.g. Clean Architecture, Onion, Vertical Slice, Modular Monolith, Microservices, CQRS, Repository+UoW)' },
  design_pattern: { type: 'string', description: 'Specific design pattern(s) to apply' },
  framework: { type: 'string', description: 'Framework in use (e.g. ASP.NET Core, NestJS, Express, Spring Boot)' },
  coding_style: { type: 'string', description: 'Coding style/formatting conventions to follow' },
  naming_convention: { type: 'string', description: 'Naming convention to follow (e.g. PascalCase classes, camelCase methods)' },
  project_rules: { type: 'string', description: 'Project-specific rules or constraints the generated code must respect' },
  target_folder: { type: 'string', description: 'Target folder/namespace the generated file(s) belong to' },
  project_context: { type: 'string', description: 'Existing project tree, dependencies, namespaces, or conventions the output must match' },
  provider: { type: 'string', description: 'AI Provider' },
  model: { type: 'string', description: 'Model to use' },
};

function buildGenerationTask(
  taskIdPrefix: string,
  taskName: string,
  toolName: string,
  args: any,
  generationMode: string,
  extra: { spec: string; file_type?: string; defaultModel?: string }
): TaskDefinition {
  return {
    id: `task-${taskIdPrefix}-${Date.now()}`,
    name: taskName,
    toolName,
    providerId: args.provider || config.orchestrator.defaultProvider,
    model: args.model || extra.defaultModel || config.deepseek.defaultReasonerModel,
    promptTemplate: 'generate',
    variables: {
      generation_mode: generationMode,
      spec: extra.spec,
      language: args.language || 'auto-detect',
      file_type: extra.file_type || args.file_type || 'N/A',
      architecture: args.architecture || 'Follow existing project conventions',
      design_pattern: args.design_pattern || 'N/A',
      framework: args.framework || 'N/A',
      coding_style: args.coding_style || 'Idiomatic for the target language',
      naming_convention: args.naming_convention || 'Idiomatic for the target language',
      project_rules: args.project_rules || 'N/A',
      target_folder: args.target_folder || 'N/A',
      project_context: args.project_context || 'N/A',
    },
  };
}

export const ALL_TOOLS: ToolDefinition[] = [
  // 1. review_code
  {
    name: 'review_code',
    description: 'Review a single file or code snippet for bugs, quality, and best practices using DeepSeek',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The code content to review' },
        language: { type: 'string', description: 'Programming language (e.g. typescript, python, csharp)' },
        focus: { type: 'string', description: 'Specific focus area (e.g. error handling, performance)' },
        provider: { type: 'string', description: 'AI Provider (default: deepseek)' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['code'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-review-code-${Date.now()}`,
        name: 'Code Review Task',
        toolName: 'review_code',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'review',
        variables: {
          content: args.code,
          language: args.language || 'auto-detect',
          scope: 'Single File / Snippet',
          focus: args.focus || 'General Code Quality & Bug Detection',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 2. review_folder
  {
    name: 'review_folder',
    description: 'Review multiple files within a folder to analyze relationships and module code quality',
    inputSchema: {
      type: 'object',
      properties: {
        folder_content: { type: 'string', description: 'Aggregated content of files in the folder' },
        folder_name: { type: 'string', description: 'Name of the folder being reviewed' },
        provider: { type: 'string', description: 'AI Provider (default: deepseek)' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['folder_content'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-review-folder-${Date.now()}`,
        name: `Folder Review Task (${args.folder_name || 'Folder'})`,
        toolName: 'review_folder',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'review',
        variables: {
          content: args.folder_content,
          language: 'mixed',
          scope: `Folder Level: ${args.folder_name || 'Target Folder'}`,
          focus: 'Module Structure, Inter-file Dependencies, Clean Code',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 3. review_project
  {
    name: 'review_project',
    description: 'Perform a comprehensive high-level project review utilizing DeepSeek Reasoner model',
    inputSchema: {
      type: 'object',
      properties: {
        project_summary: { type: 'string', description: 'Overview and code structure of the project' },
        provider: { type: 'string', description: 'AI Provider (default: deepseek)' },
        model: { type: 'string', description: 'Model to use (default: deepseek-reasoner)' },
      },
      required: ['project_summary'],
    },
    handler: async (args, router) => {
      // Execute deep parallel audit tasks: Code + Security + Architecture
      const tasks: TaskDefinition[] = [
        {
          id: `task-proj-code-${Date.now()}`,
          name: 'Project Code Audit',
          toolName: 'review_project',
          providerId: args.provider || config.orchestrator.defaultProvider,
          model: args.model || config.deepseek.defaultChatModel,
          promptTemplate: 'review',
          variables: {
            content: args.project_summary,
            language: 'project-wide',
            scope: 'Full Project Codebase',
            focus: 'Overall Code Maintenance & Standards',
          },
        },
        {
          id: `task-proj-arch-${Date.now()}`,
          name: 'Project Architecture Audit',
          toolName: 'review_project',
          providerId: args.provider || config.orchestrator.defaultProvider,
          model: args.model || config.deepseek.defaultReasonerModel,
          promptTemplate: 'architecture',
          variables: {
            content: args.project_summary,
          },
        },
        {
          id: `task-proj-sec-${Date.now()}`,
          name: 'Project Security Audit',
          toolName: 'review_project',
          providerId: args.provider || config.orchestrator.defaultProvider,
          model: args.model || config.deepseek.defaultReasonerModel,
          promptTemplate: 'security',
          variables: {
            content: args.project_summary,
          },
        },
      ];

      const results = await router.executeParallel(tasks);
      const merged = ResultMerger.merge(results);
      return merged.markdownReport;
    },
  },

  // 4. review_sql
  {
    name: 'review_sql',
    description: 'Review SQL queries, table schemas, database migrations, and index performance',
    inputSchema: {
      type: 'object',
      properties: {
        sql_content: { type: 'string', description: 'SQL queries or DDL schema definition' },
        database_type: { type: 'string', description: 'DB Engine (e.g. PostgreSQL, SQL Server, MySQL, SQLite)' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['sql_content'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-review-sql-${Date.now()}`,
        name: 'SQL & Database Review Task',
        toolName: 'review_sql',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'sql',
        variables: {
          content: `${args.database_type ? `-- Database Type: ${args.database_type}\n` : ''}${args.sql_content}`,
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 5. review_architecture
  {
    name: 'review_architecture',
    description: 'Analyze system architecture, design patterns, scalability, and coupling bottlenecks using Reasoner LLM',
    inputSchema: {
      type: 'object',
      properties: {
        architecture_description: { type: 'string', description: 'Architecture specification or component layout' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-reasoner)' },
      },
      required: ['architecture_description'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-review-arch-${Date.now()}`,
        name: 'Software Architecture Review',
        toolName: 'review_architecture',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultReasonerModel,
        promptTemplate: 'architecture',
        variables: {
          content: args.architecture_description,
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 6. review_security
  {
    name: 'review_security',
    description: 'Perform a deep cybersecurity audit focusing on OWASP vulnerabilities, secret leaks, and access control',
    inputSchema: {
      type: 'object',
      properties: {
        code_or_config: { type: 'string', description: 'Code or configuration to audit for security flaws' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-reasoner)' },
      },
      required: ['code_or_config'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-review-sec-${Date.now()}`,
        name: 'Security Audit Task',
        toolName: 'review_security',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultReasonerModel,
        promptTemplate: 'security',
        variables: {
          content: args.code_or_config,
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 7. review_performance
  {
    name: 'review_performance',
    description: 'Identify performance bottlenecks, memory leaks, algorithmic complexity (Big O), and async I/O overhead',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to optimize for performance' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-reasoner)' },
      },
      required: ['code'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-review-perf-${Date.now()}`,
        name: 'Performance Review Task',
        toolName: 'review_performance',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultReasonerModel,
        promptTemplate: 'performance',
        variables: {
          content: args.code,
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 8. write_tests
  {
    name: 'write_tests',
    description: 'Generate high-coverage unit or integration tests for the provided code',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Target code for test generation' },
        framework: { type: 'string', description: 'Test framework (e.g. Jest, Vitest, JUnit, xUnit, PyTest)' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['code'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-write-tests-${Date.now()}`,
        name: 'Unit/Integration Test Generation',
        toolName: 'write_tests',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'tests',
        variables: {
          content: args.code,
          framework: args.framework || 'Standard Framework (Jest/Vitest/xUnit/PyTest)',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 9. generate_seed
  {
    name: 'generate_seed',
    description: 'Generate realistic mock data / seed fixtures for database tables or API payloads',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'Schema structure or entity description' },
        format: { type: 'string', description: 'Desired output format (e.g. SQL INSERT, JSON, CSV)' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['schema'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-gen-seed-${Date.now()}`,
        name: 'Seed Data Generation',
        toolName: 'generate_seed',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'seed',
        variables: {
          content: args.schema,
          format: args.format || 'SQL / JSON',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 10. summarize
  {
    name: 'summarize',
    description: 'Summarize complex codebases, documentations, or technical specifications',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Content to summarize' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['text'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-summarize-${Date.now()}`,
        name: 'Content Summarization',
        toolName: 'summarize',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'documentation',
        variables: {
          content: args.text,
          mode: 'Executive Technical Summary',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 11. documentation
  {
    name: 'documentation',
    description: 'Generate clean technical Markdown documentation for APIs, classes, or modules',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to document' },
        doc_type: { type: 'string', description: 'Type of documentation (e.g. API Docs, README, JSDoc/Docstring)' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['code'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-doc-${Date.now()}`,
        name: 'Technical Documentation Generation',
        toolName: 'documentation',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'documentation',
        variables: {
          content: args.code,
          mode: args.doc_type || 'Comprehensive Technical Documentation',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 12. analyze_repository
  {
    name: 'analyze_repository',
    description: 'Analyze repository directory structure, key dependencies, and high-level architectural design',
    inputSchema: {
      type: 'object',
      properties: {
        repository_tree: { type: 'string', description: 'Directory layout tree or package manifest' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-reasoner)' },
      },
      required: ['repository_tree'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-analyze-repo-${Date.now()}`,
        name: 'Repository Analysis Task',
        toolName: 'analyze_repository',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultReasonerModel,
        promptTemplate: 'architecture',
        variables: {
          content: `Repository Structure Analysis:\n${args.repository_tree}`,
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 13. explain_code
  {
    name: 'explain_code',
    description: 'Explain step-by-step how a specific complex piece of code works',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code snippet to explain' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['code'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-explain-${Date.now()}`,
        name: 'Code Explanation Task',
        toolName: 'explain_code',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultChatModel,
        promptTemplate: 'documentation',
        variables: {
          content: args.code,
          mode: 'Detailed Step-by-Step Code Walkthrough',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 14. refactor_code
  {
    name: 'refactor_code',
    description: 'Provide refactored version of code adhering to Clean Code, SOLID principles, and optimal patterns',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to refactor' },
        refactor_goal: { type: 'string', description: 'Specific refactoring goal (e.g. extract functions, convert to async, apply pattern)' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-reasoner)' },
      },
      required: ['code'],
    },
    handler: async (args, router) => {
      const task: TaskDefinition = {
        id: `task-refactor-${Date.now()}`,
        name: 'Code Refactoring Task',
        toolName: 'refactor_code',
        providerId: args.provider || config.orchestrator.defaultProvider,
        model: args.model || config.deepseek.defaultReasonerModel,
        promptTemplate: 'review',
        variables: {
          content: args.code,
          language: 'auto-detect',
          scope: 'Code Refactoring',
          focus: args.refactor_goal || 'Clean Code, Modern Patterns & Optimization',
        },
      };

      const result = await router.executeTask(task);
      const merged = ResultMerger.merge([result]);
      return merged.markdownReport;
    },
  },

  // 15. generate_code
  {
    name: 'generate_code',
    description: 'Generate a brand-new single file (Repository, Service, Controller, DTO, Entity, Validator, Middleware, Background Job, Migration, Stored Procedure, View, Interface, Extension, Configuration, etc.) from a specification using DeepSeek. Returns structured, saveable file content — never writes to disk itself.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Full specification of what to generate: purpose, inputs/outputs, behavior, dependencies' },
        file_type: { type: 'string', description: 'Kind of file (e.g. Repository, Service, Controller, DTO, Entity, Validator, Middleware, Background Job, Migration, Stored Procedure, View, Interface, Extension, Configuration)' },
        file_name: { type: 'string', description: 'Desired file name' },
        ...GENERATION_COMMON_PROPERTIES,
      },
      required: ['spec'],
    },
    handler: async (args, router) => {
      const task = buildGenerationTask('gen-code', 'Single File Generation', 'generate_code', args, 'Single File', {
        spec: `${args.spec}${args.file_name ? `\n\nDesired file name: ${args.file_name}` : ''}`,
        file_type: args.file_type,
      });
      const result = await router.executeTask(task);
      return GenerationMerger.merge(result);
    },
  },

  // 16. generate_files
  {
    name: 'generate_files',
    description: 'Generate several related files in one call (e.g. a full module: interface + implementation + DTOs + validators + mapper + controller). Returns structured, saveable file content — never writes to disk itself.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Full specification of the module/feature to generate' },
        module_name: { type: 'string', description: 'Name of the module/feature (e.g. User, Order, Authentication)' },
        components: { type: 'string', description: 'List/description of the components expected (e.g. "IUserRepository, UserRepository, IUserService, UserService, DTOs, Validators, Mapper, Controller, Unit Tests")' },
        ...GENERATION_COMMON_PROPERTIES,
      },
      required: ['spec'],
    },
    handler: async (args, router) => {
      const task = buildGenerationTask('gen-files', `Multi-File Generation${args.module_name ? ` (${args.module_name})` : ''}`, 'generate_files', args, 'Multi-File Module', {
        spec: `${args.spec}${args.module_name ? `\n\nModule name: ${args.module_name}` : ''}${args.components ? `\n\nExpected components: ${args.components}` : ''}`,
      });
      const result = await router.executeTask(task);
      return GenerationMerger.merge(result);
    },
  },

  // 17. generate_sql
  {
    name: 'generate_sql',
    description: 'Generate SQL objects — stored procedures, views, functions, triggers, migrations, indexes — from a specification. Returns structured, saveable file content — never writes to disk itself.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Specification of the SQL object(s) to generate: purpose, tables involved, parameters, expected behavior' },
        database_type: { type: 'string', description: 'DB Engine (e.g. PostgreSQL, SQL Server, MySQL, SQLite)' },
        sql_object_type: { type: 'string', description: 'Kind of SQL object (e.g. Stored Procedure, View, Function, Trigger, Migration, Index)' },
        naming_convention: { type: 'string', description: 'Naming convention for SQL objects' },
        target_folder: { type: 'string', description: 'Target folder for the generated SQL file(s)' },
        project_context: { type: 'string', description: 'Existing schema/tables/conventions the output must match' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['spec'],
    },
    handler: async (args, router) => {
      const task = buildGenerationTask('gen-sql', 'SQL Object Generation', 'generate_sql', args, 'SQL Objects', {
        spec: `${args.spec}${args.database_type ? `\n\nDatabase Type: ${args.database_type}` : ''}`,
        file_type: args.sql_object_type,
        defaultModel: config.deepseek.defaultChatModel,
      });
      const result = await router.executeTask(task);
      return GenerationMerger.merge(result);
    },
  },

  // 18. generate_tests
  {
    name: 'generate_tests',
    description: 'Generate a full, saveable test-suite (unit/integration/performance) as file(s) from a specification or existing code — distinct from write_tests, which returns inline review-style test code. Returns structured, saveable file content — never writes to disk itself.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Code to test or specification of behavior to cover' },
        framework: { type: 'string', description: 'Test framework (e.g. Jest, Vitest, JUnit, xUnit, PyTest)' },
        test_scope: { type: 'string', description: 'Scope of tests (e.g. Unit, Integration, Performance, or combination)' },
        naming_convention: { type: 'string', description: 'Test file/naming convention' },
        target_folder: { type: 'string', description: 'Target folder for the generated test file(s)' },
        project_context: { type: 'string', description: 'Existing project conventions the tests must match' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['spec'],
    },
    handler: async (args, router) => {
      const task = buildGenerationTask('gen-tests', 'Test Suite Generation', 'generate_tests', args, 'Test Suite', {
        spec: `${args.spec}${args.test_scope ? `\n\nTest scope: ${args.test_scope}` : ''}`,
        file_type: args.framework,
        defaultModel: config.deepseek.defaultChatModel,
      });
      const result = await router.executeTask(task);
      return GenerationMerger.merge(result);
    },
  },

  // 19. generate_documentation
  {
    name: 'generate_documentation',
    description: 'Generate a full, saveable documentation set (README, API docs, architecture docs, Mermaid sequence diagrams) as file(s) — distinct from documentation, which returns inline Markdown for a single piece of content. Returns structured, saveable file content — never writes to disk itself.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Code/project to document or description of what should be documented' },
        doc_set: { type: 'string', description: 'Which docs to produce (e.g. "README, API Docs, Architecture Docs, Sequence Diagram")' },
        target_folder: { type: 'string', description: 'Target folder for the generated doc file(s)' },
        project_context: { type: 'string', description: 'Existing project structure/conventions the docs must reflect' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-chat)' },
      },
      required: ['spec'],
    },
    handler: async (args, router) => {
      const task = buildGenerationTask('gen-docs', 'Documentation Set Generation', 'generate_documentation', args, 'Documentation Set', {
        spec: `${args.spec}${args.doc_set ? `\n\nRequested documents: ${args.doc_set}` : ''}`,
        defaultModel: config.deepseek.defaultChatModel,
      });
      const result = await router.executeTask(task);
      return GenerationMerger.merge(result);
    },
  },

  // 20. generate_project
  {
    name: 'generate_project',
    description: 'Generate a full project scaffold under a named architecture (Clean Architecture, Onion, Vertical Slice, Modular Monolith, Microservices, CQRS, Repository+UoW). Recommended for small-to-medium scaffolds in one call; for large projects call generate_files repeatedly per module instead of expecting one call to build an entire system. Returns structured, saveable file content — never writes to disk itself.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Description of the project/system to scaffold' },
        architecture: { type: 'string', description: 'Architecture/template to use (e.g. Clean Architecture, Onion, Vertical Slice, Modular Monolith, Microservices, CQRS, Repository+UoW)' },
        database: { type: 'string', description: 'Database technology (e.g. PostgreSQL, SQL Server)' },
        framework: { type: 'string', description: 'Framework in use (e.g. ASP.NET Core, NestJS)' },
        language: { type: 'string', description: 'Target programming language' },
        naming_convention: { type: 'string', description: 'Naming convention to follow' },
        target_folder: { type: 'string', description: 'Root folder for the scaffolded project' },
        project_context: { type: 'string', description: 'Existing project structure/conventions the scaffold must fit into, if any' },
        provider: { type: 'string', description: 'AI Provider' },
        model: { type: 'string', description: 'Model to use (default: deepseek-reasoner)' },
      },
      required: ['spec'],
    },
    handler: async (args, router) => {
      const task = buildGenerationTask('gen-project', 'Full Project Scaffold Generation', 'generate_project', args, 'Full Project Scaffold', {
        spec: `${args.spec}${args.database ? `\n\nDatabase: ${args.database}` : ''}`,
      });
      const result = await router.executeTask(task);
      return GenerationMerger.merge(result);
    },
  },
];
